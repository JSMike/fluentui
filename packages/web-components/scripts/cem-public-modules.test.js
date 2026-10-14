import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { publicModulePath, publicModulesPlugin } from './cem-public-modules.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('TextArea and Option document the tag names used by their definitions', () => {
  for (const folder of ['textarea', 'option']) {
    const source = readFileSync(new URL(`../src/${folder}/${folder}.ts`, import.meta.url), 'utf8');
    const options = readFileSync(new URL(`../src/${folder}/${folder}.options.ts`, import.meta.url), 'utf8');
    const suffix = /export const tagName = `\$\{FluentDesignSystem.prefix\}([^`]+)`/.exec(options)[1];
    assert.equal(/@tag (\S+)/.exec(source)[1], `fluent${suffix}`);
  }
});

test('option aliases reference public exports with exact spans in compound types', () => {
  const plugin = publicModulesPlugin();
  const source = ts.createSourceFile(
    'src/button/button.ts',
    "import { ButtonAppearance as Appearance } from './button.options.js';",
    ts.ScriptTarget.Latest,
    true,
  );
  const type = { text: 'Appearance | { Appearance: Appearance[]; label: "Appearance" }' };
  const moduleDoc = { path: source.fileName, declarations: [{ members: [{ name: 'appearance', type }] }] };
  plugin.analyzePhase({ ts, node: source.statements[0], moduleDoc });
  plugin.moduleLinkPhase({ ts, moduleDoc });
  assert.deepEqual(type.references, [
    { name: 'ButtonAppearance', module: './button/options.js', start: 0, end: 10 },
    { name: 'ButtonAppearance', module: './button/options.js', start: 27, end: 37 },
  ]);
  for (const reference of type.references) {
    assert.equal(type.text.slice(reference.start, reference.end), 'Appearance');
  }
});

test('component paths use the existing public exports and actual source folder', () => {
  for (const [source, entry, pattern, capture] of [
    ['src/button/button.ts', './button/class.js', './*/class.js', 'button'],
    ['src/button/button.base.ts', './button/base.js', './*/base.js', 'button'],
    ['src/textarea/textarea.ts', './textarea/class.js', './*/class.js', 'textarea'],
    ['src/option/option.ts', './option/class.js', './*/class.js', 'option'],
    ['src/button/button.options.ts', './button/options.js', './*/options.js', 'button'],
  ]) {
    assert.equal(publicModulePath(source), entry);
    assert.equal(
      packageJson.exports[pattern].replaceAll('*', capture),
      source.replace(/^src\//, './dist/esm/').replace(/\.ts$/, '.js'),
    );
  }
  assert.equal(publicModulePath('src/patterns/start-end.ts'), 'src/patterns/start-end.ts');
  assert.equal(publicModulePath('/src/button/button.base.js'), './button/base.js');
  assert.equal(publicModulePath('/src/button/button.js'), './button/class.js');
  assert.equal(publicModulePath('src/button/define-async.ts'), './button/define-async.js');
  assert.equal(publicModulePath('src/button/button.definition-async.ts'), './button/definition-async.js');
  assert.equal(publicModulePath('src/utils/orientation.ts'), './utils/orientation.js');
  assert.equal(publicModulePath('src/theme/set-theme.ts'), './theme/set-theme.js');
  assert.equal(publicModulePath('src/index.js'), '.');
});

test('only actual tagged elements get definitions and all local references follow the public paths', () => {
  const manifest = {
    modules: [
      {
        kind: 'javascript-module',
        path: 'src/button/button.base.ts',
        declarations: [{ kind: 'class', name: 'BaseButton', customElement: true }],
        exports: [
          { kind: 'js', name: 'BaseButton', declaration: { name: 'BaseButton', module: 'src/button/button.base.ts' } },
        ],
      },
      {
        kind: 'javascript-module',
        path: 'src/textarea/textarea.ts',
        declarations: [
          {
            kind: 'class',
            name: 'TextArea',
            customElement: true,
            tagName: 'fluent-textarea',
            modulePath: 'src/textarea/textarea.ts',
            superclass: { name: 'BaseButton', module: '/src/button/button.base.js' },
            members: [
              {
                name: 'size',
                type: {
                  text: 'TextAreaSize',
                  references: [{ name: 'TextAreaSize', module: 'src/textarea/textarea.options.ts' }],
                },
              },
            ],
          },
        ],
        exports: [
          { kind: 'js', name: 'TextArea', declaration: { name: 'TextArea', module: 'src/textarea/textarea.ts' } },
        ],
      },
      {
        kind: 'javascript-module',
        path: 'src/utils/test.ts',
        declarations: [{ superclass: { name: 'Other', package: 'other', module: 'src/button/button.ts' } }],
      },
    ],
  };
  publicModulesPlugin().packageLinkPhase({ customElementsManifest: manifest });
  assert.equal(manifest.modules.length, 4);
  assert.equal(manifest.modules[0].path, './button/base.js');
  assert.equal(manifest.modules[0].exports[0].declaration.module, './button/base.js');
  assert.equal(manifest.modules[1].declarations[0].superclass.module, './button/base.js');
  assert.equal(manifest.modules[1].declarations[0].modulePath, './textarea/class.js');
  assert.equal(manifest.modules[1].declarations[0].members[0].type.references[0].module, './textarea/options.js');
  assert.equal(manifest.modules[2].declarations[0].superclass.module, 'src/button/button.ts');
  assert.deepEqual(manifest.modules[3], {
    kind: 'javascript-module',
    path: './textarea/define.js',
    declarations: [],
    exports: [
      {
        kind: 'custom-element-definition',
        name: 'fluent-textarea',
        declaration: { name: 'TextArea', module: './textarea/class.js' },
      },
    ],
  });
});
