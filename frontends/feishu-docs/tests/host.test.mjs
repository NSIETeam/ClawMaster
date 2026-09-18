/** Feishu host: tool surface, credential seam, route contract and read-only guarantees. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/host.ts';
import { FEISHU_CAPABILITIES_PATH, FEISHU_WHOAMI_PATH } from '../src/protocol.ts';

const CONFIG = { appId: 'cli_test', appSecretRef: 'DSH_TEST_SECRET' };

const TOOL_NAMES = [
  'feishu_whoami',
  'feishu_capabilities',
  'feishu_doc_read',
  'feishu_wiki_spaces',
  'feishu_wiki_nodes',
  'feishu_wiki_read',
  'feishu_drive_list',
];

/**
 * A minimal stand-in for the DSH Fetch, tool and credential services.
 *
 * Deliberately exposes NO approval service: this package must register only tools that
 * never ask for approval, so an `apply` that succeeds here proves the read-only claim.
 */
function harness({ secret = 'test-secret' } = {}) {
  const routes = new Map();
  const tools = new Map();
  let install;
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => { routes.delete(route.path); };
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => { tools.delete(definition.name); };
      },
    },
    credentials: {
      async resolve() {
        return secret === null ? undefined : { value: secret, source: 'test' };
      },
    },
    effect(operation) {
      install = operation();
      return install;
    },
  };
  return {
    ctx, routes, tools,
    async dispose() { const remove = await install; await remove(); },
  };
}

let restoreFetch = null;
afterEach(() => {
  if (restoreFetch !== null) restoreFetch();
  restoreFetch = null;
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  restoreFetch = () => { globalThis.fetch = original; };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFeishu(handler) {
  stubFetch(async (url, init) => {
    if (String(url).includes('tenant_access_token')) {
      return json({ code: 0, tenant_access_token: 'tok-1', expire: 7200 });
    }
    return handler(String(url), init);
  });
}

const exec = () => ({ signal: new AbortController().signal });

async function withHost(run, options) {
  const host = harness(options);
  await apply(host.ctx, CONFIG);
  try {
    return await run(host);
  } finally {
    await host.dispose();
  }
}

describe('feishu docs host', () => {
  it('registers the read-only tool surface and the diagnostic routes', async () => {
    await withHost(async host => {
      assert.deepEqual([...host.tools.keys()].sort(), [...TOOL_NAMES].sort());
      assert.deepEqual([...host.routes.keys()].sort(), [FEISHU_CAPABILITIES_PATH, FEISHU_WHOAMI_PATH].sort());
      for (const tool of host.tools.values()) {
        assert.equal(typeof tool.execute, 'function');
        assert.ok(tool.description.length > 0, 'every tool carries an agent-facing description');
      }
    });
  });

  it('reports the app identity through the tool and the route', async () => {
    stubFeishu(async () => json({ code: 0, bot: { app_name: 'KING', open_id: 'ou_x', activate_status: 2 } }));

    await withHost(async host => {
      const viaTool = await host.tools.get('feishu_whoami').execute({}, exec());
      assert.deepEqual(viaTool, { appId: 'cli_test', name: 'KING', openId: 'ou_x', activated: 2 });

      const response = await host.routes.get(FEISHU_WHOAMI_PATH).fetch(new Request('http://localhost' + FEISHU_WHOAMI_PATH));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { appId: 'cli_test', name: 'KING', openId: 'ou_x', activated: 2 });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  });

  it('classifies each capability and names the scopes Feishu requires', async () => {
    stubFeishu(async url => {
      if (url.includes('/bot/v3/info')) return json({ code: 0, bot: { app_name: 'KING', activate_status: 2 } });
      if (url.includes('/docx/')) return json({ code: 99992402, msg: 'field validation failed' });
      return json({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [wiki:wiki:readonly]' });
    });

    await withHost(async host => {
      const report = await host.tools.get('feishu_capabilities').execute({}, exec());
      assert.equal(report.identityError, null);
      assert.equal(report.identity.name, 'KING');

      const wiki = report.probes.find(entry => entry.name === 'wiki spaces');
      assert.equal(wiki.status, 'missing-scope');
      assert.deepEqual([...wiki.requiredScopes], ['wiki:wiki:readonly']);

      const docx = report.probes.find(entry => entry.name === 'docx metadata');
      assert.equal(docx.status, 'error', 'a non-scope failure is not misreported as a missing scope');
      assert.equal(report.probes.every(entry => entry.status !== 'granted'), true);
    });
  });

  it('still reports every probe when the identity lookup itself fails', async () => {
    stubFeishu(async () => json({
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [im:chat:readonly]',
    }));

    await withHost(async host => {
      const report = await host.tools.get('feishu_capabilities').execute({}, exec());
      assert.equal(report.identity, null);
      assert.match(report.identityError, /im:chat:readonly/);
      assert.equal(report.probes.length, 4, 'the probe results survive an identity failure');
    });
  });

  it('refuses a wiki read when the scope is missing, with the scopes Feishu asked for', async () => {
    stubFeishu(async () => json({
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [wiki:wiki:readonly]',
    }));

    await withHost(async host => {
      await assert.rejects(
        () => host.tools.get('feishu_wiki_spaces').execute({}, exec()),
        error => {
          assert.equal(error.name, 'FeishuScopeError');
          assert.deepEqual([...error.scopes], ['wiki:wiki:readonly']);
          return true;
        },
      );
    });
  });

  it('renders a document as Markdown from the blocks endpoint', async () => {
    stubFeishu(async url => {
      if (url.includes('/blocks')) {
        return json({
          code: 0,
          data: {
            items: [
              { block_id: 'page', block_type: 1, children: ['h', 'p'], page: {} },
              { block_id: 'h', block_type: 3, parent_id: 'page', heading1: { elements: [{ text_run: { content: 'Overview' } }] } },
              { block_id: 'p', block_type: 2, parent_id: 'page', text: { elements: [{ text_run: { content: 'Body' } }] } },
            ],
            has_more: false,
          },
        });
      }
      return json({ code: 0, data: { document: { document_id: 'doxcnX', revision_id: 7, title: 'Handbook' } } });
    });

    await withHost(async host => {
      const document = await host.tools.get('feishu_doc_read').execute({ document: 'doxcnX' }, exec());
      assert.equal(document.title, 'Handbook');
      assert.equal(document.revisionId, '7');
      assert.equal(document.blockCount, 3);
      assert.match(document.markdown, /^# Handbook$/m);
      assert.match(document.markdown, /^# Overview$/m);
      assert.match(document.markdown, /^Body$/m);
    });
  });

  it('accepts a pasted document URL as well as a bare token', async () => {
    const requested = [];
    stubFeishu(async url => {
      requested.push(url);
      if (url.includes('/blocks')) return json({ code: 0, data: { items: [], has_more: false } });
      return json({ code: 0, data: { document: { document_id: 'doxcnFromUrl', title: 'From URL' } } });
    });

    await withHost(async host => {
      await host.tools.get('feishu_doc_read').execute(
        { document: 'https://example.feishu.cn/docx/doxcnFromUrl' },
        exec(),
      );
      assert.equal(requested.some(url => url.includes('/documents/doxcnFromUrl')), true);
    });
  });

  it('fails clearly when the credential reference is not configured', async () => {
    stubFeishu(async () => json({ code: 0, bot: { app_name: 'KING' } }));

    await withHost(async host => {
      await assert.rejects(
        () => host.tools.get('feishu_whoami').execute({}, exec()),
        error => {
          assert.equal(error.name, 'FeishuConfigError');
          assert.match(error.message, /DSH_TEST_SECRET/);
          return true;
        },
      );
    }, { secret: null });
  });

  it('maps a missing scope on the identity route to HTTP 403 with the required scopes', async () => {
    stubFeishu(async () => json({
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [im:chat:readonly]',
    }));

    await withHost(async host => {
      const response = await host.routes.get(FEISHU_WHOAMI_PATH)
        .fetch(new Request('http://localhost' + FEISHU_WHOAMI_PATH));
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error.code, 'missing_scope');
      assert.deepEqual(body.error.requiredScopes, ['im:chat:readonly']);
    });
  });

  it('removes every route and tool on dispose', async () => {
    stubFeishu(async () => json({ code: 0, bot: { app_name: 'KING' } }));

    const host = harness();
    await apply(host.ctx, CONFIG);
    assert.equal(host.tools.size, TOOL_NAMES.length);
    await host.dispose();
    assert.equal(host.tools.size, 0);
    assert.equal(host.routes.size, 0);
  });

  it('rejects a config without an app id', async () => {
    const host = harness();
    await assert.rejects(() => apply(host.ctx, { appSecretRef: 'DSH_TEST_SECRET' }));
    await assert.rejects(() => apply(host.ctx, { appId: 'cli_test', appSecretRef: 'not a ref!' }));
  });
});
