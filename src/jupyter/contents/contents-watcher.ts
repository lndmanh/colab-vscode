/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode, {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  Uri,
  WindowState,
} from 'vscode';
import { log } from '../../common/logging';
import {
  OverrunPolicy,
  SequentialTaskRunner,
  StartMode,
} from '../../common/task-runner';
import { toFileType } from '../client/converters';
import { Contents, ContentsApi, ResponseError } from '../client/generated';
import { DirectoryPoller } from './directory-poller';
import { JupyterConnectionManager } from './sessions';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_TASK_TIMEOUT_MS = 30000;

interface WatcherTimingOptions {
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly taskTimeoutMs?: number;
}

interface Poller extends Disposable {
  readonly refCount: number;
  addRef(): number;
  release(): number;
  start(): void;
  suspend(): void;
  resume(): void;
}

interface EndpointState {
  readonly pollers: Map<string, Poller>;
}

interface PendingPoller {
  refCount: number;
  promise: Promise<Poller | undefined>;
}

interface FileSnapshot {
  readonly type: vscode.FileType;
  readonly mtime: number;
  readonly size: number;
}

/**
 * Owns Colab contents watch subscriptions and their polling life cycles.
 *
 * Consumers subscribe through this class using the VS Code file-system watch
 * contract. The watcher creates pollers only for the exact URIs consumers ask
 * for; recursive and exclude flags are accepted but intentionally ignored.
 */
export class ContentsWatcher implements Disposable {
  private readonly changeEmitter: EventEmitter<FileChangeEvent[]>;
  private readonly focusListener: Disposable;
  private readonly revokeListener: Disposable;
  private readonly endpointStates = new Map<string, EndpointState>();
  private readonly pendingPollers = new Map<string, PendingPoller>();
  private readonly timing: Required<WatcherTimingOptions>;
  private isDisposed = false;
  private isSuspended = false;

  /** File change event aggregated from all active pollers. */
  readonly onDidChangeFile: Event<FileChangeEvent[]>;

  /**
   * Initializes a new instance.
   *
   * @param vs - VS Code API instance.
   * @param jupyterConnections - Existing Jupyter connection manager.
   * @param timing - Optional polling timing overrides for tests.
   */
  constructor(
    private readonly vs: typeof vscode,
    private readonly jupyterConnections: JupyterConnectionManager,
    timing: WatcherTimingOptions = {},
  ) {
    this.timing = {
      intervalMs: timing.intervalMs ?? DEFAULT_INTERVAL_MS,
      maxBackoffMs: timing.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      taskTimeoutMs: timing.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    };
    this.changeEmitter = new vs.EventEmitter<FileChangeEvent[]>();
    this.onDidChangeFile = this.changeEmitter.event;
    this.focusListener = vs.window.onDidChangeWindowState(
      this.handleWindowState.bind(this),
    );
    this.revokeListener = jupyterConnections.onDidRevokeConnections(
      this.disposeEndpoints.bind(this),
    );
  }

  /** Disposes all pollers and listeners owned by this watcher. */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.focusListener.dispose();
    this.revokeListener.dispose();
    for (const endpoint of this.endpointStates.keys()) {
      this.disposeEndpoint(endpoint);
    }
    for (const pending of this.pendingPollers.values()) {
      pending.refCount = 0;
    }
    this.pendingPollers.clear();
    this.changeEmitter.dispose();
  }

  /**
   * Watches exactly one URI requested by a VS Code file-system consumer.
   *
   * @param uri - URI to watch.
   * @param _options - VS Code watch options. Accepted but not evaluated.
   * @returns Disposable that releases this watch subscription.
   */
  watch(
    uri: Uri,
    _options: {
      readonly recursive: boolean;
      readonly excludes: readonly string[];
    },
  ): Disposable {
    this.guardDisposed();
    const key = this.pollerKey(uri);
    const endpointState = this.getEndpointState(uri.authority);
    const existing = endpointState.pollers.get(key);
    if (existing) {
      existing.addRef();
      return this.createReleaseDisposable(uri.authority, key);
    }

    const pending = this.pendingPollers.get(key);
    if (pending) {
      pending.refCount += 1;
      return this.createReleaseDisposable(uri.authority, key);
    }

    const created: PendingPoller = {
      refCount: 1,
      promise: Promise.resolve(undefined),
    };
    created.promise = this.createPoller(uri, created);
    this.pendingPollers.set(key, created);
    void created.promise.finally(() => {
      const current = this.pendingPollers.get(key);
      if (current === created) {
        this.pendingPollers.delete(key);
      }
    });
    return this.createReleaseDisposable(uri.authority, key);
  }

  private guardDisposed(): void {
    if (this.isDisposed) {
      throw new Error('Cannot use ContentsWatcher after it has been disposed');
    }
  }

  private pollerKey(uri: Uri): string {
    return uri.path;
  }

  private getEndpointState(endpoint: string): EndpointState {
    let state = this.endpointStates.get(endpoint);
    if (!state) {
      state = { pollers: new Map() };
      this.endpointStates.set(endpoint, state);
    }
    return state;
  }

  private createReleaseDisposable(endpoint: string, key: string): Disposable {
    let isDisposed = false;
    return {
      dispose: () => {
        if (isDisposed) {
          return;
        }
        isDisposed = true;
        const state = this.endpointStates.get(endpoint);
        const poller = state?.pollers.get(key);
        const pending = this.pendingPollers.get(key);
        if (pending) {
          pending.refCount = Math.max(0, pending.refCount - 1);
          return;
        }
        if (!state || !poller) {
          return;
        }
        if (poller.release() === 0) {
          poller.dispose();
          state.pollers.delete(key);
          if (state.pollers.size === 0) {
            this.endpointStates.delete(endpoint);
          }
        }
      },
    };
  }

  private async createPoller(
    uri: Uri,
    pending: PendingPoller,
  ): Promise<Poller | undefined> {
    const client = await this.getExistingClient(uri.authority);
    if (!client || this.isDisposed || pending.refCount === 0) {
      return undefined;
    }

    let metadata: Contents;
    try {
      metadata = await client.get({ path: uri.path, content: 0 });
    } catch (error: unknown) {
      if (error instanceof ResponseError && error.response.status === 404) {
        this.changeEmitter.fire([
          { type: this.vs.FileChangeType.Deleted, uri },
        ]);
        return undefined;
      }
      throw error;
    }

    if (pending.refCount === 0) {
      return undefined;
    }

    const poller =
      metadata.type === 'directory'
        ? this.createDirectoryPoller(uri)
        : this.createFilePoller(uri, metadata);
    for (let i = 0; i < pending.refCount; i += 1) {
      poller.addRef();
    }
    this.getEndpointState(uri.authority).pollers.set(
      this.pollerKey(uri),
      poller,
    );
    if (!this.isSuspended) {
      poller.start();
    }
    return poller;
  }

  private createDirectoryPoller(uri: Uri): DirectoryPoller {
    return new DirectoryPoller({
      vs: this.vs,
      uri,
      getClient: () => this.getExistingClient(uri.authority),
      onDidChangeFile: (events) => {
        this.fireChanges(events);
        if (events.some((event) => event.uri.toString() === uri.toString())) {
          this.removePoller(uri);
        }
      },
      intervalMs: this.timing.intervalMs,
      maxBackoffMs: this.timing.maxBackoffMs,
      taskTimeoutMs: this.timing.taskTimeoutMs,
    });
  }

  private createFilePoller(uri: Uri, initialMetadata: Contents): FilePoller {
    return new FilePoller({
      vs: this.vs,
      uri,
      initialMetadata,
      getClient: () => this.getExistingClient(uri.authority),
      onDidChangeFile: this.fireChanges.bind(this),
      onDidTerminate: () => {
        this.removePoller(uri);
      },
      intervalMs: this.timing.intervalMs,
      maxBackoffMs: this.timing.maxBackoffMs,
      taskTimeoutMs: this.timing.taskTimeoutMs,
    });
  }

  private async getExistingClient(
    endpoint: string,
  ): Promise<ContentsApi | undefined> {
    try {
      return await this.jupyterConnections.get(endpoint);
    } catch (error: unknown) {
      log.warn(`Unable to get existing Jupyter client for ${endpoint}`, error);
      return undefined;
    }
  }

  private fireChanges(events: readonly FileChangeEvent[]): void {
    this.changeEmitter.fire([...events]);
  }

  private handleWindowState(state: WindowState): void {
    if (!state.focused) {
      this.isSuspended = true;
      for (const poller of this.allPollers()) {
        poller.suspend();
      }
      return;
    }

    this.isSuspended = false;
    for (const poller of this.allPollers()) {
      poller.start();
      poller.resume();
    }
  }

  private disposeEndpoints(endpoints: readonly string[]): void {
    for (const endpoint of endpoints) {
      this.disposeEndpoint(endpoint);
    }
  }

  private disposeEndpoint(endpoint: string): void {
    const state = this.endpointStates.get(endpoint);
    if (!state) {
      return;
    }
    for (const poller of state.pollers.values()) {
      poller.dispose();
    }
    this.endpointStates.delete(endpoint);
  }

  private removePoller(uri: Uri): void {
    const state = this.endpointStates.get(uri.authority);
    if (!state) {
      return;
    }
    state.pollers.delete(this.pollerKey(uri));
    if (state.pollers.size === 0) {
      this.endpointStates.delete(uri.authority);
    }
  }

  private allPollers(): Poller[] {
    return [...this.endpointStates.values()].flatMap((state) => [
      ...state.pollers.values(),
    ]);
  }
}

interface FilePollerOptions extends WatcherTimingOptions {
  readonly vs: typeof vscode;
  readonly uri: Uri;
  readonly initialMetadata: Contents;
  readonly getClient: () => Promise<ContentsApi | undefined>;
  readonly onDidChangeFile: (events: readonly FileChangeEvent[]) => void;
  readonly onDidTerminate: () => void;
}

class FilePoller implements Poller {
  private readonly runner: SequentialTaskRunner;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private snapshot: FileSnapshot;
  private refCountValue = 0;
  private isDisposed = false;
  private isStarted = false;
  private isSuspended = false;
  private currentBackoffMs: number;
  private nextPollTimeMs = 0;

  constructor(private readonly options: FilePollerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.currentBackoffMs = this.intervalMs;
    this.snapshot = this.toSnapshot(options.initialMetadata);
    this.runner = new SequentialTaskRunner(
      {
        intervalTimeoutMs: this.intervalMs,
        taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        abandonGraceMs: 0,
      },
      {
        name: `${FilePoller.name}:${options.uri.toString()}`,
        run: this.poll.bind(this),
      },
      OverrunPolicy.AbandonAndRun,
    );
  }

  get refCount(): number {
    return this.refCountValue;
  }

  addRef(): number {
    this.guardDisposed();
    this.refCountValue += 1;
    return this.refCountValue;
  }

  release(): number {
    this.guardDisposed();
    if (this.refCountValue === 0) {
      return 0;
    }
    this.refCountValue -= 1;
    if (this.refCountValue === 0) {
      this.runner.stop();
      this.isStarted = false;
      this.isSuspended = false;
      this.currentBackoffMs = this.intervalMs;
      this.nextPollTimeMs = 0;
    }
    return this.refCountValue;
  }

  start(): void {
    this.guardDisposed();
    if (this.isStarted || this.refCountValue === 0) {
      return;
    }
    this.isStarted = true;
    this.runner.start(StartMode.Scheduled);
  }

  suspend(): void {
    this.guardDisposed();
    if (!this.isStarted || this.isSuspended) {
      return;
    }
    this.isSuspended = true;
    this.runner.stop();
  }

  resume(): void {
    this.guardDisposed();
    if (!this.isStarted || !this.isSuspended || this.refCountValue === 0) {
      return;
    }
    this.isSuspended = false;
    this.nextPollTimeMs = 0;
    this.runner.start(StartMode.Immediately);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.refCountValue = 0;
    this.runner.dispose();
  }

  private guardDisposed(): void {
    if (this.isDisposed) {
      throw new Error('Cannot use FilePoller after it has been disposed');
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    if (this.isSuspended || Date.now() < this.nextPollTimeMs) {
      return;
    }
    const client = await this.options.getClient();
    if (!client) {
      return;
    }
    try {
      const contents = await client.get(
        { path: this.options.uri.path, content: 0 },
        { signal },
      );
      this.handleSuccess(this.toSnapshot(contents));
    } catch (error: unknown) {
      this.handlePollError(error);
    }
  }

  private toSnapshot(contents: Contents): FileSnapshot {
    return {
      type: toFileType(this.options.vs, contents.type),
      mtime: contents.lastModified
        ? new Date(contents.lastModified).getTime()
        : 0,
      size: contents.size ?? 0,
    };
  }

  private handleSuccess(snapshot: FileSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    this.currentBackoffMs = this.intervalMs;
    this.nextPollTimeMs = 0;
    if (
      snapshot.type !== previous.type ||
      snapshot.mtime !== previous.mtime ||
      snapshot.size !== previous.size
    ) {
      this.options.onDidChangeFile([
        { type: this.options.vs.FileChangeType.Changed, uri: this.options.uri },
      ]);
    }
  }

  private handlePollError(error: unknown): void {
    if (error instanceof ResponseError && error.response.status === 404) {
      this.options.onDidChangeFile([
        { type: this.options.vs.FileChangeType.Deleted, uri: this.options.uri },
      ]);
      this.dispose();
      this.options.onDidTerminate();
      return;
    }
    log.warn(`Unable to poll ${this.options.uri.toString()}`, error);
    this.nextPollTimeMs = Date.now() + this.currentBackoffMs;
    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * 2,
      this.maxBackoffMs,
    );
  }
}
