/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { FileChangeEvent, WindowState } from 'vscode';
import { TestEventEmitter } from '../../test/helpers/events';
import { TestUri } from '../../test/helpers/uri';
import {
  FileChangeType,
  newVsCodeStub,
  VsCodeStub,
} from '../../test/helpers/vscode';
import { DirectoryContents } from '../client/converters';
import {
  Contents,
  ContentsApi,
  ResponseError,
} from '../client/generated';
import { ContentsWatcher } from './contents-watcher';
import { JupyterConnectionManager } from './sessions';

const INTERVAL_MS = 5000;
const NOT_FOUND = new ResponseError(new Response(undefined, { status: 404 }));

function content(
  path: string,
  type: 'file' | 'directory' = 'file',
  lastModified = '2026-01-01T00:00:00Z',
  size = 1,
): Contents {
  const name = path.split('/').at(-1) ?? '';
  return {
    name,
    path,
    type,
    writable: true,
    created: '2026-01-01T00:00:00Z',
    lastModified,
    size: type === 'directory' ? undefined : size,
    mimetype: type === 'directory' ? '' : 'text/plain',
    content: '',
    format: '',
  };
}

function directory(path: string, children: Contents[]): DirectoryContents {
  return {
    ...content(path, 'directory'),
    type: 'directory',
    content: children,
  };
}

describe('ContentsWatcher', () => {
  let vs: VsCodeStub;
  let clock: sinon.SinonFakeTimers;
  let client: sinon.SinonStubbedInstance<ContentsApi>;
  let jupyter: sinon.SinonStubbedInstance<JupyterConnectionManager>;
  let windowStateEmitter: TestEventEmitter<WindowState>;
  let revokeEmitter: TestEventEmitter<string[]>;
  let watcher: ContentsWatcher;
  let listener: sinon.SinonStub<[readonly FileChangeEvent[]]>;

  async function advance(ms = INTERVAL_MS): Promise<void> {
    await clock.tickAsync(ms);
  }

  beforeEach(() => {
    vs = newVsCodeStub();
    clock = sinon.useFakeTimers();
    client = sinon.createStubInstance(ContentsApi);
    jupyter = sinon.createStubInstance(JupyterConnectionManager);
    jupyter.get.withArgs('m-s-foo').resolves(client);
    windowStateEmitter = new TestEventEmitter<WindowState>();
    vs.window.onDidChangeWindowState.callsFake(windowStateEmitter.event);
    revokeEmitter = new TestEventEmitter<string[]>();
    Object.defineProperty(jupyter, 'onDidRevokeConnections', {
      value: sinon.stub(),
    });
    jupyter.onDidRevokeConnections.callsFake(revokeEmitter.event);
    watcher = new ContentsWatcher(vs.asVsCode(), jupyter, {
      intervalMs: INTERVAL_MS,
      taskTimeoutMs: 30000,
    });
    listener = sinon.stub();
    watcher.onDidChangeFile(listener);
  });

  afterEach(() => {
    watcher.dispose();
    sinon.restore();
  });

  it('shares directory pollers for identical watched URIs', async () => {
    client.get.onCall(0).resolves(content('/foo', 'directory'));
    client.get.onCall(1).resolves(directory('/foo', []));
    client.get.onCall(2).resolves(directory('/foo', [content('/foo/a.txt')]));

    const uri = TestUri.parse('colab://m-s-foo/foo');
    const first = watcher.watch(uri, { recursive: true, excludes: ['**/*'] });
    const second = watcher.watch(uri, { recursive: false, excludes: [] });
    await advance(0);
    await advance();

    sinon.assert.calledOnceWithExactly(listener, [
      {
        type: FileChangeType.Created,
        uri: TestUri.parse('colab://m-s-foo/foo/a.txt'),
      },
    ]);

    first.dispose();
    await advance();
    second.dispose();
    await advance();

    sinon.assert.callCount(client.get, 4);
  });

  it('polls watched file URIs directly', async () => {
    client.get.onCall(0).resolves(content('/foo/a.txt'));
    client.get.onCall(1).resolves(content('/foo/a.txt'));
    client.get
      .onCall(2)
      .resolves(content('/foo/a.txt', 'file', '2026-01-01T00:01:00Z'));

    watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    await advance(0);
    await advance();
    await advance();

    sinon.assert.calledOnceWithExactly(listener, [
      {
        type: FileChangeType.Changed,
        uri: TestUri.parse('colab://m-s-foo/foo/a.txt'),
      },
    ]);
    sinon.assert.calledWithExactly(
      client.get,
      { path: '/foo/a.txt', content: 0 },
      sinon.match.has('signal'),
    );
  });

  it('emits deleted for watched files when direct polling returns 404', async () => {
    client.get.onCall(0).resolves(content('/foo/a.txt'));
    client.get.onCall(1).rejects(NOT_FOUND);

    const uri = TestUri.parse('colab://m-s-foo/foo/a.txt');
    const disposable = watcher.watch(uri, {
      recursive: false,
      excludes: [],
    });
    await advance(0);
    await advance();

    sinon.assert.calledOnceWithExactly(listener, [
      {
        type: FileChangeType.Deleted,
        uri,
      },
    ]);

    disposable.dispose();
    client.get.onCall(2).resolves(content('/foo/a.txt'));
    watcher.watch(uri, { recursive: false, excludes: [] });
    await advance(0);

    sinon.assert.callCount(client.get, 3);
  });

  it('does not create a poller when the watch is disposed while pending', async () => {
    let resolveClient!: (client: ContentsApi) => void;
    jupyter.get.withArgs('m-s-foo').returns(
      new Promise<ContentsApi>((resolve) => {
        resolveClient = resolve;
      }),
    );

    const disposable = watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    disposable.dispose();
    client.get.onCall(0).resolves(content('/foo/a.txt'));
    resolveClient(client);
    await advance(0);
    await advance();

    sinon.assert.notCalled(client.get);
  });

  it('does not add a pending duplicate watch after it is disposed', async () => {
    let resolveMetadata!: (metadata: Contents) => void;
    client.get.onCall(0).returns(
      new Promise<Contents>((resolve) => {
        resolveMetadata = resolve;
      }),
    );

    watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    const duplicate = watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    duplicate.dispose();
    resolveMetadata(content('/foo/a.txt'));
    await advance(0);
    client.get.onCall(1).resolves(content('/foo/a.txt'));
    await advance();

    sinon.assert.calledTwice(client.get);
  });

  it('suspends pollers while VS Code is unfocused and resumes immediately', async () => {
    client.get.onCall(0).resolves(content('/foo/a.txt'));
    client.get.onCall(1).resolves(content('/foo/a.txt'));
    client.get
      .onCall(2)
      .resolves(content('/foo/a.txt', 'file', '2026-01-01T00:01:00Z'));

    watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    await advance(0);
    windowStateEmitter.fire({ focused: false, active: false });
    await advance(INTERVAL_MS * 3);
    sinon.assert.calledOnce(client.get);

    windowStateEmitter.fire({ focused: true, active: true });
    await advance(0);

    sinon.assert.calledTwice(client.get);
  });

  it('tears down pollers for revoked endpoints', async () => {
    client.get.onCall(0).resolves(content('/foo/a.txt'));

    watcher.watch(TestUri.parse('colab://m-s-foo/foo/a.txt'), {
      recursive: false,
      excludes: [],
    });
    await advance(0);
    revokeEmitter.fire(['m-s-foo']);
    await advance();

    sinon.assert.calledOnce(client.get);
    expect(revokeEmitter.hasListeners()).to.be.true;
  });

  it('does not poll new directory watches while suspended', async () => {
    windowStateEmitter.fire({ focused: false, active: false });
    client.get.onCall(0).resolves(content('/foo', 'directory'));
    client.get.onCall(1).resolves(directory('/foo', []));

    watcher.watch(TestUri.parse('colab://m-s-foo/foo'), {
      recursive: true,
      excludes: [],
    });
    await advance(0);
    await advance(INTERVAL_MS * 3);

    sinon.assert.calledOnce(client.get);
  });
});
