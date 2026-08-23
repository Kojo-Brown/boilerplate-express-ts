# Immutability: readonly types, a dev-mode freeze, and pure updates

Three mechanisms with one job — stopping a value with several holders from being
edited by one of them — and each covers what the other two cannot.

## The bug this is about

A cache is the clearest case, because the sharing is not optional.

```ts
// src/lib/route-decorators/cache-store.ts, with the guards elided
set<T>(key: string, value: T, ttlMs: number): Promise<void> {
  this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
}
```

`MemoryCacheStore` stores the object. It does not serialise it, and it does not
copy it — those are the properties that make it fast enough to sit in front of
`GET /v1/users` with a five-second TTL. So the array handed to the request that
missed is the same array handed to the next hundred requests that hit.

Now put an ordinary line in a handler downstream of it:

```ts
const users = await listUsers(req);
users.sort(byCreatedAt);          // or: delete user.password_hash
```

Nothing here is wrong on its own, and the compiler agrees: the operation's
return type is `UserRow[]`, and `UserRow[]` is a mutable array. What actually
happened is that the cache entry was reordered, every request for the next five
seconds is answered from the reordered copy, and then the entry expires and the
symptom disappears. The bug report is "the list is sometimes in the wrong
order", the code that reordered it is three modules away, and the reproduction
depends on a TTL.

The same shape shows up in two other places in this codebase:

- **The event bus.** `publish` builds one envelope and every subscriber receives
  that object. Subscribers run concurrently, so a handler that normalises a
  payload before using it changes what the others read. The audit line comes out
  wrong because the session-revocation subscriber lowercased an id, and those
  two files share no import.
- **Configuration.** `env` is imported by fifteen modules that all treat it as a
  constant. The usual way it gets written to is a test reaching for
  `env.NODE_ENV = 'production'` to exercise a branch: it passes, the change
  leaks into every later test in the file, and the failure lands elsewhere.

## Why three mechanisms

**`DeepReadonly<T>` is the one that scales**, because it costs nothing at
runtime and reports at the call site. It is also the one with a hole:
TypeScript ignores `readonly` property modifiers when it checks assignability,
so `{ readonly a: string }` and `{ a: string }` are mutually assignable and a
handler annotated with the mutable type is accepted wherever the readonly one is
expected. The type stops the person who was going to be stopped by a comment; it
does not stop a cast, an erased generic, or a value that reached the code
through `unknown`.

`Readonly<T>` is not enough for any of this. It freezes the outermost layer and
leaves `value.user.email = 'x'` legal, and nobody reassigns the root of a
structure they were handed — they reach into it.

**`deepFreeze` is the one that cannot be argued with**, because a write to a
frozen object throws. Every file here compiles under `alwaysStrict` (implied by
`strict`), so it is a `TypeError` at the offending line rather than a silent
no-op. The cost is a walk of the structure on every value.

**`freezeInDev` is the compromise**: freeze outside production, where the walk is
affordable and a mutation is reproducible; return the argument untouched in
production, where the walk is per-cached-response. That makes it an assertion
rather than a guarantee, with the usual trade — worth having because the failure
it catches is otherwise silent, and the mutation it would have caught in
production now fails in CI first.

Its return type is `T`, unchanged. Widening it to `DeepReadonly<T>` would make a
decorator's static contract depend on `NODE_ENV`, and would push a caching
detail into the signature of every operation that passes through one. Where the
type *should* carry the guarantee, the value is not a "freeze in dev" candidate
at all — it is immutable everywhere, and `deepFreeze` says so. `env` is that
case, and is frozen unconditionally: one object, walked once at boot.

## What `Object.freeze` cannot do

Freezing is weaker than it sounds, and the module refuses to pretend otherwise.

| Value | `Object.freeze` | What actually protects it |
| --- | --- | --- |
| Plain object, array, class instance | Real — a write throws | The freeze |
| `Date` | Nothing: the time is an internal slot, `setTime` still works | Nothing. The *property* cannot be replaced |
| `Map`, `Set` | Nothing: `set`/`add` write internal slots | `ReadonlyMap`/`ReadonlySet` from `DeepReadonly` |
| `Buffer`, any typed array | **Throws** — integer-indexed exotic properties cannot be made non-configurable | Nothing |
| `Error` | Real, and harmful: `stack` is written lazily on first read | — |
| Function | Real, and harmful: decorators and test doubles assign properties | — |

So `deepFreeze` walks past all of them. The typed-array row is the one that
would have hurt: a `Buffer` inside a cached response would have turned a
dev-only check into a dev-only crash, which is the worst place to discover it.
It recurses through `Map` and `Set` *contents* without freezing the container,
because the contents are ordinary objects and the container's guarantee is the
type's job.

Two further refusals: accessor properties are skipped rather than read —
invoking an unknown getter to decide whether to freeze its result is a side
effect this has no licence to cause — and a `WeakSet` guards cycles and the
diamond where two properties reference one object.

Realm-crossing is handled by matching `Object.prototype.toString` rather than
`instanceof`: a value structured-cloned back from a worker thread was built in
that thread's realm, so its prototype is not this realm's `Date.prototype`.

## Deriving instead of writing

Once a value is frozen, the question is how to change it, and the general answer
is to build a new one. The object spread already is that answer for the common
case, so `src/lib/immutable/update.ts` holds only what spread does badly:

- **`patch(value, changes)`** returns the *same reference* when nothing actually
  changed. Spread always allocates, so `{ ...row, ...body }` produces a new
  object for a no-op `PUT` and every `===` downstream — a memo, a cache
  validator, a "did this change?" guard — reports a change that did not happen.
  Comparison is `Object.is` per key: shallow on purpose, since a deep comparison
  turns a cheap merge into a walk of both structures to catch a case the caller
  created by rebuilding it.
- **`omit`** and **`pick`** are what spread cannot express. The hand-rolled omit
  is `const rest = { ...value }; delete rest[key]`, which has to widen the copy
  to a `Record` before `delete` is legal — and the return type stops being
  checked exactly where it matters. `omit(user, 'emial')` is an error here.
  `pick` guards with `hasOwnProperty` so an absent optional property stays
  absent instead of becoming present-and-`undefined`; the two are
  indistinguishable through a property read and very distinguishable through
  `JSON.stringify` and `in`.

**There are deliberately no array helpers.** `with`, `toSorted`, `toSpliced` and
`toReversed` are the standard library's copying methods, they are declared on
`ReadonlyArray` as well as `Array`, and every Node version this package supports
(`^22.12 || ^24`) ships them. That is why `tsconfig.json` now names `ES2023` in
`lib` — `target` stays `ES2022`, since this is a claim about the runtime rather
than about syntax. With `ES2022` the compiler denies those methods exist, and
the gap gets filled by a hand-written `replaceAt` that is strictly worse than
the method it shadows.

## Where it is wired

| Site | Mechanism | Why there |
| --- | --- | --- |
| `src/config/env.ts` | `deepFreeze`, unconditional | One object, once, at boot. The export's type is `DeepReadonly`, so a write is a compile error before it is a `TypeError` |
| `MemoryCacheStore.set` | `freezeInDev` | This is where the sharing happens. A serialising store has no such hazard and should not pay for the walk |
| `EventBus.publish` | `freezeInDev` + `SubscriberView` on `on`/`once` | `publish` takes `TPayload`, `on` delivers `DeepReadonly<TPayload>`: producers write, consumers read |
| `stripUpdatedFlag` | `omit` | Removes the `delete` on a widened copy, and checks the key against the row type |

The cache freeze catches the *first* request, not the second: the object being
stored is the one the current caller is about to return, so waiting until a
second request could observe the damage would report the bug against whichever
test happened to read the entry next.

The bus freezes the publisher's own object too, since it is the same reference.
That is a real constraint and the right one — a payload the caller edits after
publishing was never a statement of fact about a moment, which is the only thing
an event can be.

## What this does not do

- **No deep-freeze in production.** By construction. A mutation that only
  happens under production traffic is not caught, it is prevented from being
  written in the first place by the types, and caught in CI by the tests.
- **No defensive copy per subscriber.** A structured clone per delivery would
  make the bus immune rather than loud, at a per-event cost, to protect against
  a mutation that should not compile.
- **No lint rule enforcing `readonly`.** `@typescript-eslint/prefer-readonly`
  and friends need type-aware linting, which this config does not run;
  switching it on is a change to the lint gate's cost and shape, not a rider on
  this one.
- **Nothing stops a `Date` or a `Buffer` being mutated in place.** See the table
  above. Where that matters, do not hand out the reference.
