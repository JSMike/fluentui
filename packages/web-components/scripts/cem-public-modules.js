import { posix } from 'node:path';

/** Resolve source modules using the public component entry points in package.json. */
export function publicModulePath(sourcePath) {
  const path = sourcePath.replace(/^\.\//, '').replace(/^src\//, '');
  const component = /^([^/]+)\/([^/]+)\.ts$/.exec(path);
  if (!component) {
    return sourcePath;
  }

  const [, folder, file] = component;
  if (file === folder) {
    return `./${folder}/class.js`;
  }
  if (file === `${folder}.base`) {
    return `./${folder}/base.js`;
  }
  if (file === `${folder}.options`) {
    return `./${folder}/options.js`;
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
      const paths = new Map(customElementsManifest.modules.map(module => [module.path, publicModulePath(module.path)]));
      const updateReferences = value => {
        if (!value || typeof value !== 'object') {
          return;
        }
        if (!value.package && typeof value.module === 'string') {
          value.module = paths.get(value.module) ?? publicModulePath(value.module);
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
