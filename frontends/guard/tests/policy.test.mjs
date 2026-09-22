/** The decision layer: high-risk asks, critical denies, and the paths that move the line. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.ts';
import { DEFAULT_OPTIONS, parseOptions, reviewCall, shellCommandOf, workdirOf } from '../src/policy.ts';

const context = { home: '/Users/king', cwd: '/work' };
const call = (command, name = 'bash') => ({ name, arguments: { command } });
const review = (command, options = DEFAULT_OPTIONS) => reviewCall(call(command), options, context);

describe('review decisions', () => {
  it('denies an irreversible command outright', () => {
    const { decision, finding } = review('rm -rf /');
    assert.equal(finding.risk, 'critical');
    assert.equal(decision?.kind, 'deny');
    assert.match(decision.reason, /delete\.broad/);
    assert.match(decision.reason, /denies|refuses/);
  });

  it('asks for approval instead of approving a destructive command', () => {
    const { decision, finding } = review('rm -rf build');
    assert.equal(finding.risk, 'high');
    assert.equal(decision?.kind, 'ask');
    assert.match(decision.reason, /build/);
    assert.match(decision.reason, /never grants one on the model's behalf/);
  });

  it('delegates ordinary work untouched', () => {
    for (const command of ['ls -la', 'pnpm test', 'git status --short', 'echo hi > out.txt']) {
      assert.equal(review(command).decision, undefined, command);
    }
  });

  it('leaves the tool alone when it is not a reviewed shell call', () => {
    assert.equal(reviewCall({ name: 'edit', arguments: { file_path: 'a.ts' } }, DEFAULT_OPTIONS, context).decision, undefined);
    assert.equal(shellCommandOf({ name: 'edit', arguments: { command: 'rm -rf /' } }, DEFAULT_OPTIONS), undefined);
    assert.equal(shellCommandOf(call('   '), DEFAULT_OPTIONS), undefined);
  });

  it('observes without deciding when asked to', () => {
    const observed = review('rm -rf build', { ...DEFAULT_OPTIONS, mode: 'observe' });
    assert.equal(observed.decision, undefined);
    assert.equal(observed.finding.risk, 'high');
  });

  it('allows a high-risk action inside a configured scratch path', () => {
    const options = { ...DEFAULT_OPTIONS, allowPaths: ['/tmp/scratch'] };
    assert.equal(reviewCall(call('rm -rf /tmp/scratch'), options, context).decision, undefined);
    assert.equal(reviewCall(call('rm -rf /tmp/scratch/out'), options, context).decision, undefined);
    assert.equal(reviewCall(call('rm -rf /tmp/keep'), options, context).decision?.kind, 'ask');
  });

  it('denies a protected path even when the rules would only ask', () => {
    const options = { ...DEFAULT_OPTIONS, denyPaths: ['/work/keep'] };
    const { decision } = reviewCall(call('rm -rf /work/keep/data'), options, context);
    assert.equal(decision?.kind, 'deny');
    assert.match(decision.reason, /protected path/);
  });

  it('reads the declared working directory', () => {
    assert.equal(workdirOf({ name: 'bash', arguments: { workdir: '/srv/app' } }), '/srv/app');
    assert.equal(workdirOf({ name: 'bash', arguments: { workdir: 'relative' } }), undefined);
    const finding = reviewCall({ name: 'bash', arguments: { command: 'rm -rf ..', workdir: '/srv/app' } }, DEFAULT_OPTIONS, { home: '/root', cwd: '/srv/app' });
    assert.equal(finding.finding.risk, 'critical');
  });
});

describe('configuration', () => {
  it('fills every field from the defaults', () => {
    assert.deepEqual(parseOptions(undefined), DEFAULT_OPTIONS);
    assert.deepEqual(parseOptions(null), DEFAULT_OPTIONS);
    assert.equal(parseOptions({ mode: 'observe' }).mode, 'observe');
    assert.equal(parseOptions({ mode: 'nonsense' }).mode, 'enforce');
    assert.deepEqual(parseOptions({ allowPaths: ['/tmp'] }).allowPaths, ['/tmp']);
    assert.deepEqual(parseOptions({ allowPaths: 'not-a-list' }).allowPaths, []);
  });

  it('keeps a configured reviewed-tool list, including a named argument', () => {
    const configured = parseOptions({ shellTools: ['bash', { name: 'terminal_send', argument: 'text' }] }).shellTools;
    assert.deepEqual(configured, ['bash', { name: 'terminal_send', argument: 'text' }]);
  });

  it('falls back to the default list when any reviewed-tool entry is unusable', () => {
    for (const unusable of ['', { name: 'terminal_send' }, { argument: 'text' }, { name: '', argument: 'text' }, 7, null, []]) {
      assert.deepEqual(parseOptions({ shellTools: ['bash', unusable] }).shellTools, DEFAULT_OPTIONS.shellTools, JSON.stringify(unusable));
    }
    assert.deepEqual(parseOptions({ shellTools: 'bash' }).shellTools, DEFAULT_OPTIONS.shellTools);
  });
});

describe('reviewed tools', () => {
  it('reviews command text that arrives under a named argument', () => {
    const options = parseOptions({ shellTools: [{ name: 'terminal_send', argument: 'text' }] });
    const call = { name: 'terminal_send', arguments: { sessionId: 't1', text: 'rm -rf /' } };
    assert.equal(shellCommandOf(call, options), 'rm -rf /');
    assert.equal(reviewCall(call, options, context).decision?.kind, 'deny');
  });

  it('does not read the argument a bare name would use', () => {
    const options = parseOptions({ shellTools: [{ name: 'terminal_send', argument: 'text' }] });
    assert.equal(shellCommandOf({ name: 'terminal_send', arguments: { command: 'rm -rf /' } }, options), undefined);
  });

  it('still reads command for a bare name', () => {
    const options = parseOptions({ shellTools: ['pwsh'] });
    assert.equal(shellCommandOf({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse /' } }, options), 'Remove-Item -Recurse /');
  });

  it('covers the shipped default list, terminal input included', () => {
    assert.deepEqual(DEFAULT_OPTIONS.shellTools, ['bash', 'shell', 'run_command', 'exec', { name: 'terminal_send', argument: 'text' }]);
    assert.equal(shellCommandOf({ name: 'terminal_send', arguments: { text: 'rm -rf /' } }, DEFAULT_OPTIONS), 'rm -rf /');
    assert.equal(reviewCall({ name: 'terminal_send', arguments: { text: 'rm -rf /' } }, DEFAULT_OPTIONS, context).decision?.kind, 'deny');
  });
});

describe('mounting', () => {
  /** A host context that records what the guard registered and logged. */
  function host() {
    const listeners = new Map();
    const logs = [];
    return {
      listeners,
      logs,
      ctx: {
        on: (event, listener) => { listeners.set(event, listener); },
        logger: { info: message => logs.push(message), warn: message => logs.push(message) },
      },
    };
  }

  it('registers the process and result stages and reports all three defaults', () => {
    const fake = host();
    apply(fake.ctx);
    // The default is a working three-stage guard: review a call, hold a plan to its acceptance,
    // and archive what the turn actually did.
    assert.deepEqual([...fake.listeners.keys()], ['tools/pre-execute', 'session/event']);
    assert.match(fake.logs[0], /mounted \(mode enforce, plan review enforce, result review archive\)/);
  });

  it('subscribes to the result stage only when a review is wanted', () => {
    const quiet = host();
    apply(quiet.ctx, { resultReview: 'off' });
    assert.deepEqual([...quiet.listeners.keys()], ['tools/pre-execute']);
    assert.match(quiet.logs[0], /result review off/);
  });

  it('denies through the listener and delegates safe calls to the pipeline', async () => {
    const fake = host();
    apply(fake.ctx);
    const listener = fake.listeners.get('tools/pre-execute');
    let delegated = 0;
    const next = async () => { delegated += 1; return { kind: 'allow' }; };

    const denied = await listener({ name: 'bash', arguments: { command: 'rm -rf ~' } }, next);
    assert.equal(denied.kind, 'deny');
    assert.equal(delegated, 0, 'a denial must not reach the pipeline');

    const allowed = await listener({ name: 'bash', arguments: { command: 'ls -la' } }, next);
    assert.equal(allowed.kind, 'allow');
    assert.equal(delegated, 1);

    assert.ok(fake.logs.some(message => message.includes('clawmaster-guard: deny')));
  });

  it('delegates instead of failing when the review itself throws', async () => {
    const fake = host();
    apply(fake.ctx);
    const listener = fake.listeners.get('tools/pre-execute');
    // A getter that throws exercises the fail-open path without patching the node built-ins.
    const hostile = { name: 'bash', get arguments() { throw new Error('unreadable arguments'); } };
    const decision = await listener(hostile, async () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow');
    assert.ok(fake.logs.some(message => message.includes('review failed, delegating')));
  });
});
