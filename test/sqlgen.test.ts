import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesSchema, columnDefinition, createIfNotExists, gridSql, ident, insertBatch, isGenerated, isReadOnly, literal, orderViews, riskyStatements, rowSql, safeFileName, toCsv, toJson, viewDefinition } from '../src/mysql/sqlgen';

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

test('isReadOnly accepts only reading statements', () => {
	assert.equal(isReadOnly('SELECT 1; show tables; -- x'), true);
	assert.equal(isReadOnly("SELECT 'delete'; UPDATE t SET a = 1 WHERE id = 1"), false);
	assert.equal(isReadOnly('WITH x AS (SELECT 1) DELETE FROM t'), false);
	assert.equal(isReadOnly(''), false);
});

test('changesSchema detects DDL only', () => {
	assert.equal(changesSchema('alter table t add c int'), true);
	assert.equal(changesSchema('/* x */ CREATE TABLE t (id int)'), true);
	assert.equal(changesSchema('SELECT 1; DROP VIEW v'), true);
	assert.equal(changesSchema("SELECT 'drop table x'"), false);
	assert.equal(changesSchema('TRUNCATE t; UPDATE t SET a = 1'), false);
});

test('toCsv quotes when needed, NULL is empty', () => {
	assert.equal(toCsv(['a', 'b'], [['x,y', null], ['say "hi"', 3]]), 'a,b\r\n"x,y",\r\n"say ""hi""",3\r\n');
});

test('toJson keys rows by column, binary as base64', () => {
	assert.deepEqual(JSON.parse(toJson(['id', 'bin'], [[1, Buffer.from('hi')]])), [{ id: 1, bin: 'aGk=' }]);
});

test('literal escapes strings, keeps numbers, hex for binary', () => {
	assert.equal(literal(null), 'NULL');
	assert.equal(literal(5), '5');
	assert.equal(literal("it's \\ ok\n"), "'it\\'s \\\\ ok\\n'");
	assert.equal(literal(Buffer.from([1, 255])), "X'01ff'");
});

test('rowSql uses the primary key, falls back to all columns', () => {
	const src = { db: 'd', table: 't', columns: ['id', 'name', 'note'] };
	assert.equal(rowSql('update', src, [7, 'a', null], ['id']), "UPDATE `d`.`t` SET\n\t`name` = 'a',\n\t`note` = NULL\nWHERE `id` = 7\nLIMIT 1;\n");
	assert.equal(rowSql('delete', src, [7, 'a', null], []),
		"-- Attenzione: chiave primaria assente nel risultato, la riga è identificata da tutte le colonne\nDELETE FROM `d`.`t`\nWHERE `id` = 7\n\tAND `name` = 'a'\n\tAND `note` IS NULL\nLIMIT 1;\n");
	assert.equal(rowSql('insert', src, [7, 'a', null], ['id']), "INSERT INTO `d`.`t` (`name`, `note`)\nVALUES (\n\t'a',\n\tNULL\n);\n");
});

test('gridSql builds DELETE/UPDATE/INSERT by original primary key and drops bad input', () => {
	const src = { db: 'd', table: 't', columns: ['id', 'name', 'note'] };
	const rows = [[1, 'a', null], [2, 'b', 'x']];
	assert.deepEqual(gridSql(src, ['id'], rows, {
		deletes: [1, 9],
		updates: [{ row: 0, values: { 0: '5', 2: null } }, { row: 1, values: { 1: 'z' } }, { row: 0, values: { 7: 'x', 1: 3 as any } }],
		inserts: [{ 1: "it's" }, {}],
	}), [
		'DELETE FROM `d`.`t` WHERE `id` = 2 LIMIT 1',
		'UPDATE `d`.`t` SET `id` = \'5\', `note` = NULL WHERE `id` = 1 LIMIT 1',
		"INSERT INTO `d`.`t` (`name`) VALUES ('it\\'s')",
		'INSERT INTO `d`.`t` () VALUES ()',
	]);
});

test('columnDefinition extracts a column line from SHOW CREATE TABLE', () => {
	const create = "CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) NOT NULL DEFAULT '',\n  PRIMARY KEY (`id`)\n)";
	assert.equal(columnDefinition(create, 'name'), "varchar(50) NOT NULL DEFAULT ''");
	assert.equal(columnDefinition(create, 'missing'), undefined);
});

test('export helpers: multi-row INSERT, CREATE IF NOT EXISTS, view without definer, CSV without header', () => {
	assert.equal(insertBatch('t`x', ['a', 'b'], [[1, null], ["it's\x1a\\", Buffer.from([0])]], 'REPLACE'),
		"REPLACE INTO `t``x` (`a`, `b`) VALUES\n(1, NULL),\n('it\\'s\\Z\\\\', X'00');\n");
	const create = 'CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4';
	assert.equal(createIfNotExists(create), create.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
	assert.equal(createIfNotExists(create, false), 'CREATE TABLE IF NOT EXISTS `t` (\n  `id` int NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
	assert.equal(createIfNotExists('CREATE DATABASE `d` /*!40100 DEFAULT CHARACTER SET utf8mb4 */'), 'CREATE DATABASE IF NOT EXISTS `d` /*!40100 DEFAULT CHARACTER SET utf8mb4 */');
	assert.equal(viewDefinition('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1'),
		'CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW `v` AS select 1');
	assert.equal(viewDefinition("CREATE DEFINER='u'@'%' SQL SECURITY INVOKER VIEW `v` AS select 1"), 'CREATE OR REPLACE SQL SECURITY INVOKER VIEW `v` AS select 1');
	assert.equal(viewDefinition('CREATE OR REPLACE VIEW `v` AS select 1'), 'CREATE OR REPLACE VIEW `v` AS select 1');
	assert.equal(toCsv(['a'], [['x,y']], false), '"x,y"\r\n');
});

test('orderViews puts each view after the views it uses, cycles keep the order', () => {
	const v = (name: string, uses = '') => ({ name, def: `CREATE VIEW \`${name}\` AS select * from ${uses || '`t`'}` });
	const names = (l: { name: string }[]) => l.map(x => x.name).join(',');
	assert.equal(names(orderViews([v('a', '`db`.`c`'), v('b'), v('c', '`b`')])), 'b,c,a');
	assert.equal(names(orderViews([v('x', '`y`'), v('y', '`x`'), v('z')])), 'z,x,y');
});

test('isGenerated skips DEFAULT_GENERATED, safeFileName keeps exports inside the folder', () => {
	assert.equal(isGenerated('VIRTUAL GENERATED'), true);
	assert.equal(isGenerated('STORED GENERATED'), true);
	assert.equal(isGenerated('DEFAULT_GENERATED on update CURRENT_TIMESTAMP'), false);
	assert.equal(safeFileName('../a\\b:c'), '__a_b_c');
	assert.equal(safeFileName('con'), '_con');
	assert.equal(safeFileName('nul.csv'), '_nul.csv');
	assert.equal(safeFileName('users.csv'), 'users.csv');
});
