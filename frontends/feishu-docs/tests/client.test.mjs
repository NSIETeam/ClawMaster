/** Feishu client: token lifecycle, error classification and retry behaviour. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuClient } from '../src/client.ts';
import { FeishuAuthError, FeishuScopeError } from '../src/errors.ts';

const noSleep = async () => {};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isTokenCall(url) {
  return String(url).includes('tenant_access_token');
}

/** Serve the token call automatically, delegating everything else to `handler`. */
function authenticated(handler) {
  return async (url, init) => {
    if (isTokenCall(url)) return json({ code: 0, tenant_access_token: 'tok-1', expire: 7200 });
    return handler(url, init);
  };
}

function client(options) {
  return new FeishuClient({ appId: 'cli_test', resolveSecret: async () => 'secret', sleep: noSleep, ...options });
}

describe('feishu client', () => {
  it('reuses one tenant token across requests', async () => {
    let authCalls = 0;
    const fetchImpl = async url => {
      if (isTokenCall(url)) {
        authCalls += 1;
        return json({ code: 0, tenant_access_token: 'tok-1', expire: 7200 });
      }
      return json({ code: 0, data: { ok: true } });
    };

    const instance = client({ fetchImpl });
    await instance.request('/open-apis/one');
    await instance.request('/open-apis/two');

    assert.equal(authCalls, 1);
  });

  it('re-resolves the secret and re-authenticates once the cached token is stale', async () => {
    let authCalls = 0;
    let resolutions = 0;
    let clock = 0;
    const fetchImpl = async url => {
      if (isTokenCall(url)) {
        authCalls += 1;
        return json({ code: 0, tenant_access_token: `tok-${authCalls}`, expire: 100 });
      }
      return json({ code: 0, data: {} });
    };

    const instance = new FeishuClient({
      appId: 'cli_test',
      resolveSecret: async () => { resolutions += 1; return 'secret'; },
      sleep: noSleep,
      fetchImpl,
      now: () => clock,
    });

    await instance.request('/open-apis/one');
    clock += 41_000; // 100s ttl minus the 60s skew => stale after 40s
    await instance.request('/open-apis/two');

    assert.equal(authCalls, 2);
    assert.equal(resolutions, 2, 'the secret is re-read instead of being cached on the client');
  });

  it('classifies a missing scope and exposes the required scopes', async () => {
    const instance = client({
      maxRetries: 0,
      fetchImpl: authenticated(async () => json({
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [wiki:wiki:readonly, wiki:wiki]',
      })),
    });

    await assert.rejects(
      () => instance.request('/open-apis/wiki/v2/spaces'),
      error => {
        assert.ok(error instanceof FeishuScopeError, `expected FeishuScopeError, got ${error.name}`);
        assert.equal(error.code, 99991672);
        assert.deepEqual([...error.scopes], ['wiki:wiki:readonly', 'wiki:wiki']);
        return true;
      },
    );
  });

  it('fails with an auth error when no tenant token is returned', async () => {
    const instance = client({ maxRetries: 0, fetchImpl: async () => json({ code: 0, expire: 7200 }) });
    await assert.rejects(() => instance.request('/open-apis/x'), FeishuAuthError);
  });

  it('fails with a config-style auth error when the credential resolves to nothing', async () => {
    const instance = new FeishuClient({
      appId: 'cli_test',
      resolveSecret: async () => '',
      sleep: noSleep,
      maxRetries: 0,
      fetchImpl: async () => json({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
    });

    await assert.rejects(() => instance.request('/open-apis/x'), FeishuAuthError);
  });

  it('never leaks the app secret into an error message', async () => {
    const secret = 'super-secret-value-1234567890';
    const instance = new FeishuClient({
      appId: 'cli_test',
      resolveSecret: async () => secret,
      sleep: noSleep,
      maxRetries: 0,
      fetchImpl: authenticated(async () => json({ code: 99992402, msg: 'field validation failed' })),
    });

    await assert.rejects(
      () => instance.request('/open-apis/docx/v1/documents/bad'),
      error => {
        assert.doesNotMatch(error.message, /super-secret-value/);
        return true;
      },
    );
  });

  it('follows page tokens until has_more is false', async () => {
    let page = 0;
    const instance = client({
      fetchImpl: authenticated(async () => {
        page += 1;
        if (page === 1) return json({ code: 0, data: { items: [{ id: 1 }], has_more: true, page_token: 'p2' } });
        return json({ code: 0, data: { items: [{ id: 2 }], has_more: false } });
      }),
    });

    assert.deepEqual(await instance.getAll('/open-apis/things'), [{ id: 1 }, { id: 2 }]);
  });

  it('stops when the server echoes the same page token', async () => {
    let calls = 0;
    const instance = client({
      fetchImpl: authenticated(async () => {
        calls += 1;
        return json({ code: 0, data: { items: [{ id: calls }], has_more: true, page_token: 'always-the-same' } });
      }),
    });

    assert.equal((await instance.getAll('/open-apis/things')).length, 2, 'must stop instead of looping forever');
  });

  it('retries a rate-limited call and then succeeds', async () => {
    let attempts = 0;
    const instance = client({
      maxRetries: 2,
      fetchImpl: authenticated(async () => {
        attempts += 1;
        if (attempts === 1) return json({ code: 99991400, msg: 'too many requests' });
        return json({ code: 0, data: { ok: true } });
      }),
    });

    assert.deepEqual(await instance.request('/open-apis/throttled'), { ok: true });
    assert.equal(attempts, 2);
  });

  it('reads the bot identity from the top-level envelope shape', async () => {
    // Verified against the live API: /bot/v3/info puts `bot` at the envelope top level.
    const instance = client({
      fetchImpl: authenticated(async () => json({
        code: 0,
        msg: 'success',
        bot: { app_name: 'KING', open_id: 'ou_x', activate_status: 2 },
      })),
    });

    assert.deepEqual(await instance.whoami(), {
      appId: 'cli_test',
      name: 'KING',
      openId: 'ou_x',
      activated: 2,
    });
  });

  it('still reads the bot identity if the API nests it under data', async () => {
    const instance = client({
      fetchImpl: authenticated(async () => json({
        code: 0,
        data: { bot: { app_name: 'KING', open_id: 'ou_y', activate_status: 1 } },
      })),
    });

    const identity = await instance.whoami();
    assert.equal(identity.name, 'KING');
    assert.equal(identity.activated, 1);
  });

  it('reports a null identity instead of throwing when bot fields are absent', async () => {
    const instance = client({ fetchImpl: authenticated(async () => json({ code: 0, msg: 'success' })) });

    assert.deepEqual(await instance.whoami(), { appId: 'cli_test', name: null, openId: null, activated: null });
  });
});
