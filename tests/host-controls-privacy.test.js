const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function snapshots() {
  const slots = [], effects = [], requests = [], listeners = new Map();
  let cursor, dirty, output, args = [{ on: (name, fn) => listeners.set(name, fn), off: name => listeners.delete(name) }, 'synthetic-room', true, 'visible'];
  const source = readFileSync(require.resolve('../client/src/DisplayPage.jsx'), 'utf8');
  const body = source.slice(source.indexOf('const useSnapshots ='), source.indexOf('\nconst JoinCard'));
  const context = vm.createContext({ AbortController, RETRY_DELAY_MS: 5000,
    setTimeout: () => 1, clearTimeout() {},
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = initial;
      return [slots[id], update => { slots[id] = typeof update === 'function' ? update(slots[id]) : update; dirty = true; }]; },
    useEffect(effect, deps) { const id = cursor++;
      if (!slots[id] || deps.some((value, i) => value !== slots[id].deps[i])) {
        effects.push(() => { slots[id]?.cleanup?.(); slots[id] = { deps, cleanup: effect() }; });
      } },
  });
  vm.runInContext(body + '\nthis.run = useSnapshots;', context);
  const render = (changes = {}) => {
    if ('key' in changes) args[3] = changes.key;
    if ('room' in changes) args[1] = changes.room;
    do { cursor = 0; dirty = false; output = context.run(...args); while (effects.length) effects.shift()(); } while (dirty);
    return output;
  };
  return { requests, render, reload() { listeners.get('snapshotsChanged')(); return render(); }, async finish(index, data) { requests[index].resolve({ ok: true, json: async () => ({ snapshots: data }) }); await new Promise(setImmediate); return render(); } };
}

test('a visibility change masks cached visible snapshots immediately and through failed reloads', async () => {
  const hook = snapshots(); hook.render();
  assert.equal((await hook.finish(0, [{ secret: 'fictional-visible-result' }])).snapshots.length, 1);
  const hidden = hook.render({ key: 'hidden' });
  assert.equal(hidden?.snapshots, undefined, 'old visible cache must disappear before the request finishes');
  hook.requests[1].reject(new Error('synthetic load failure')); await new Promise(setImmediate);
  assert.equal(hook.render()?.snapshots, undefined);
});

test('same-visibility refreshes may retain their cache while a different room never reuses it', async () => {
  const hook = snapshots(); hook.render(); await hook.finish(0, [{ id: 1 }]);
  assert.equal(hook.reload().snapshots[0].id, 1);
  hook.requests[1].reject(new Error('synthetic refresh failure')); await new Promise(setImmediate);
  assert.equal(hook.render().snapshots[0].id, 1);
  assert.equal(hook.render({ room: 'other-synthetic-room' })?.snapshots, undefined);
});
