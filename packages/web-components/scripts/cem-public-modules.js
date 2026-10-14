import { posix } from 'node:path';

import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exportedModules = Object.entries(packageJson.exports).flatMap(([entry, value]) => {
  const target = typeof value === 'string' ? value : value.default;
  if (!target?.startsWith('./dist/esm/')) {
    return [];
  }
  const segments = target.split('*').map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern =
    segments[0] +
    segments
      .slice(1)
      .map((segment, index) => `${index === 0 ? '(.+)' : '\\1'}${segment}`)
      .join('');
  return [{ entry, pattern: new RegExp(`^${pattern}$`) }];
});

/** Resolve source modules using the actual public export map, including analyzer URL paths. */
export function publicModulePath(sourcePath) {
  const normalized = sourcePath.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized.startsWith('src/')) {
    return sourcePath;
  }
  const emitted = normalized.replace(/^src\//, './dist/esm/').replace(/\.ts$/, '.js');
  for (const { entry, pattern } of exportedModules) {
    const match = pattern.exec(emitted);
    if (match) {
      return entry.replaceAll('*', match[1]);
    }
  }
  return sourcePath;
}

/** Keep source references in sync and only register classes with an actual tag. */
export function publicModulesPlugin() {
  const optionImports = new Map();
  return {
    name: 'fluent-public-modules',
    analyzePhase({ ts, node, moduleDoc }) {
      if (!ts.isImportDeclaration(node) || !node.moduleSpecifier.text.endsWith('.options.js')) {
        return;
      }
      const sourcePath = posix.join(posix.dirname(moduleDoc.path), node.moduleSpecifier.text).replace(/\.js$/, '.ts');
      const module = publicModulePath(sourcePath);
      if (!/^\.\/[^/]+\/options\.js$/.test(module)) {
        return;
      }
      const imports = optionImports.get(moduleDoc.path) ?? new Map();
      for (const specifier of node.importClause?.namedBindings?.elements ?? []) {
        imports.set(specifier.name.text, { name: (specifier.propertyName ?? specifier.name).text, module });
      }
      optionImports.set(moduleDoc.path, imports);
    },
    moduleLinkPhase({ ts, moduleDoc }) {
      const imports = optionImports.get(moduleDoc.path);
      if (!imports?.size) {
        return;
      }
      const updateTypes = value => {
        if (!value || typeof value !== 'object') {
          return;
        }
        if (typeof value.text === 'string') {
          const prefix = 'type ManifestType = ';
          const source = ts.createSourceFile(
            'manifest-type.ts',
            `${prefix}${value.text};`,
            ts.ScriptTarget.Latest,
            true,
          );
          const references = [];
          const visit = node => {
            if (ts.isTypeReferenceNode(node)) {
              const reference = imports.get(node.typeName.getText(source));
              if (reference) {
                references.push({
                  ...reference,
                  start: node.typeName.getStart(source) - prefix.length,
                  end: node.typeName.end - prefix.length,
                });
              }
            }
            ts.forEachChild(node, visit);
          };
          visit(source);
          if (references.length && !value.references?.length) {
            value.references = references;
          }
        }
        Object.values(value).forEach(updateTypes);
      };
      updateTypes(moduleDoc);
    },
    packageLinkPhase({ customElementsManifest }) {
      const paths = new Map();
      for (const module of customElementsManifest.modules) {
        const target = publicModulePath(module.path);
        const emittedSource = module.path.replace(/^\.\//, '').replace(/\.ts$/, '.js');
        paths.set(module.path, target);
        paths.set(emittedSource, target);
        paths.set(`/${emittedSource}`, target);
      }
      const updateReferences = value => {
        if (!value || typeof value !== 'object') {
          return;
        }
        if (!value.package || value.package === packageJson.name) {
          for (const key of ['module', 'modulePath']) {
            if (typeof value[key] === 'string') {
              value[key] = paths.get(value[key]) ?? publicModulePath(value[key]);
            }
          }
        }
        Object.values(value).forEach(updateReferences);
      };

      for (const module of customElementsManifest.modules) {
        updateReferences(module);
        module.path = paths.get(module.path);
      }

      const definitions = [];
      for (const module of customElementsManifest.modules) {
        for (const declaration of module.declarations ?? []) {
          if (!declaration.customElement || !declaration.tagName) {
            continue;
          }
          const folder = /^\.\/([^/]+)\/class\.js$/.exec(module.path)?.[1];
          if (!folder) {
            continue;
          }
          definitions.push({
            kind: 'javascript-module',
            path: `./${folder}/define.js`,
            declarations: [],
            exports: [
              {
                kind: 'custom-element-definition',
                name: declaration.tagName,
                declaration: { name: declaration.name, module: module.path },
              },
            ],
          });
        }
      }
      customElementsManifest.modules.push(...definitions);
    },
  };
}
