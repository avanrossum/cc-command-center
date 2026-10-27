// A registry.db shaped like Electron CCCC's at user_version 18, for the
// import tests.

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REGISTRY_FILE } from '../src/main/registry-import.ts'

export const A = 'f1bc7620-4c81-4b5c-8625-10c4c8028bad'
export const B = '043aa6cd-bfe6-43fb-ac14-8754d7888e2b'
export const C = 'dbe712b0-9bcc-4035-be6c-6ea280da5743'

export function makeRegistry(folder: string, version = 18): void {
  const db = new DatabaseSync(join(folder, REGISTRY_FILE))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = ${version};
    CREATE TABLE category (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      label TEXT, emoji TEXT, arbiter_context INTEGER NOT NULL DEFAULT 0, notify_permission INTEGER, notify_question INTEGER, notify_done INTEGER);
    CREATE TABLE node (session_id TEXT PRIMARY KEY, cwd TEXT, name TEXT, category_id INTEGER, origin TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      theme TEXT, scrollback TEXT, scrollback_at INTEGER, api_key_id INTEGER, outbox_token TEXT, resume_flags TEXT, resume_flags_sticky INTEGER, alias TEXT, archived_at INTEGER);
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO category (id, name, color, sort, created_at, label, emoji, arbiter_context, notify_permission, notify_question, notify_done) VALUES
      (3, 'Acme General', '#4ac0e2', 1, 0, 'AC-gen', '', 1, 1, 0, 1),
      (12, 'Acme - Platform v2', '#9bbf4a', 0, 0, 'PLAT V2', '👥', 1, NULL, 0, NULL),
      (21, 'Acme Governance', 'not-a-color', 2, 0, '[ACMg]', '🔥', 0, 0, 1, 0);
    INSERT INTO node (session_id, cwd, name, category_id, first_seen, last_seen, alias, resume_flags) VALUES
      ('${A}', '/Users/x/acme', 'production-log', 3, 0, 0, NULL, NULL),
      ('${B}', '/Users/x/acme', 'acme-09', 12, 0, 0, 'platform-investigation', '{"model":"opus","context":"1m","effort":"ultracode","mode":"auto"}'),
      ('${C}', '/Users/x/bbrl', NULL, NULL, 0, 0, NULL, NULL),
      ('not-a-uuid', '/x', 'skip', NULL, 0, 0, NULL, NULL);
    INSERT INTO app_state VALUES
      ('recentFolders', '["/Users/x/a","relative","/Users/x/b"]'), ('lastModel', 'opus'), ('lastEffort', 'ultracode'), ('lastMode', 'auto'),
      ('terminalFont', 'Fira Mono'), ('terminalFontSize', '18'), ('hideUnmanaged', 'true'), ('notifyEnabled', 'true'),
      ('sessionNames', '{"${C}":"bbrl-6b"}');
  `)
  // Leave the WAL in place, as a running Electron would.
  db.close()
}
