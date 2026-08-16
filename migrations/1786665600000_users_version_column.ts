import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The row version behind `If-Match` / `ETag`.
 *
 * `updated_at` is already on the table and is not a substitute. A timestamp
 * answers "when", and the question a conditional write asks is "is this still
 * the state I read?" — two writes landing inside the same clock tick share an
 * `updated_at`, and `NOW()` is the *transaction* start time in Postgres, so two
 * transactions that began together share it however far apart they commit. A
 * monotonic counter has neither problem: it changes on every write, by
 * construction, and nothing outside this table can make two states collide.
 *
 * Starting at 1 rather than 0 so that "no version" and "the first version" are
 * never the same value in a client's hands.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn('users', {
    version: { type: 'integer', notNull: true, default: 1 },
  });

  /**
   * The increment is a trigger and not `SET version = version + 1` in the
   * repository, because a validator that only holds when the writer remembers
   * to opt in is not a validator.
   *
   * `BaseRepository.update`, a migration, a psql session fixing one row by
   * hand — every one of those is a writer, and if any of them can change the
   * row without moving the version, an `ETag` handed out before that write
   * still compares equal afterwards and the conditional write it guards
   * silently overwrites the change. Putting the rule in the database makes the
   * set of writers irrelevant.
   *
   * It is `BEFORE UPDATE ... FOR EACH ROW` and unconditional. A `WHEN (OLD.* IS
   * DISTINCT FROM NEW.*)` guard looks like a saving and buys nothing here:
   * every update this codebase issues also sets `updated_at`, so the rows
   * always differ, and the guard would only add a case where the version does
   * not move for reasons the caller cannot see.
   */
  pgm.createFunction(
    'bump_row_version',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    BEGIN
      NEW.version := OLD.version + 1;
      RETURN NEW;
    END;
    `,
  );

  pgm.createTrigger('users', 'users_bump_version', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'bump_row_version',
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTrigger('users', 'users_bump_version');
  // The function is shared by name, not by table: it reads `version` off `NEW`
  // and nothing else, so a second versioned table reuses it rather than
  // declaring its own. That is also why dropping it here is safe only while
  // `users` is the one table using it — a later migration adding a second
  // trigger owns keeping this `down` honest.
  pgm.dropFunction('bump_row_version', []);
  pgm.dropColumn('users', 'version');
}
