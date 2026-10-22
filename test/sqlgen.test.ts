import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ident, riskyStatements, toCsv, toJson } from '../src/mysql/sqlgen';

test('ident escapes backticks', () => {
	assert.equal(ident('a`b'), '`a``b`');
});

test('riskyStatements flags destructive statements only', () => {
	assert.deepEqual(riskyStatements('SELECT 1; DELETE FROM t WHERE id = 1; UPDATE t SET a = 1 WHERE b'), []);
	assert.deepEqual(riskyStatements('delete from t;\nupdate t set a=1; drop table x; truncate y; alter table t drop column c'),
		['delete from t', 'update t set a=1', 'drop table x', 'truncate y', 'alter table t drop column c']);
	// WHERE inside strings or comments doesn't count, keywords inside strings don't trigger.
	assert.deepEqual(riskyStatements("UPDATE t SET a = 'where' -- where\n"), ["UPDATE t SET a = '…'"]);
	assert.deepEqual(riskyStatements("SELECT 'drop table x; delete from y' /* ; drop */"), []);
	assert.deepEqual(riskyStatements("INSERT INTO t VALUES ('it\\'s; drop table x')"), []);
});

test('toCsv quotes when needed, NULL is empty', () => {
	assert.equal(toCsv(['a', 'b'], [['x,y', null], ['say "hi"', 3]]), 'a,b\r\n"x,y",\r\n"say ""hi""",3\r\n');
});

test('toJson keys rows by column, binary as base64', () => {
	assert.deepEqual(JSON.parse(toJson(['id', 'bin'], [[1, Buffer.from('hi')]])), [{ id: 1, bin: 'aGk=' }]);
});
