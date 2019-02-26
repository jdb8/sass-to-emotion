#!/usr/bin/env node
/* eslint-disable no-param-reassign */
const postcss = require('postcss-scss');
const { list, comment } = require('postcss');
const { camelCase } = require('lodash');
const format = require('prettier-eslint');
const feBrary = require('@domain-group/fe-brary');
const selectorToLiteral = require('./selector-to-variable-identifier');

// TODO make CLI option
const FE_BRARY_PREFIX = '$fe-brary-';

const OPERATORS = [' + ', ' - ', ' / ', ' * ', ' % ', ' < ', ' > ', ' == ', ' != ', ' <= ', ' >= '];

function checkUpTree(root, node, checkerFunc) {
  let passedCheck = false;
  let parentNode = node.parent;
  do {
    if (parentNode !== root && checkerFunc(parentNode)) {
      passedCheck = true;
    }
    parentNode = parentNode.parent;
  } while (parentNode && parentNode !== root && !passedCheck);

  return passedCheck;
}

function handleSassVar(decl, root) {
  let values;

  if (decl.value.includes(',') && list.comma(decl.value)[0] !== decl.value) {
    values = list.comma(decl.value);
  } else if (decl.value.includes(' ') && list.space(decl.value)[0] !== decl.value) {
    values = list.space(decl.value);
  } else {
    values = [decl.value];
  }

  return values
    .map((string) => {
      if (string.startsWith(FE_BRARY_PREFIX)) {
        if (!root.usesFeBraryVars) {
          root.usesFeBraryVars = true;
        }

        const [, name] = string.split(FE_BRARY_PREFIX);
        const [field, ...varNameSegs] = name.split('-');
        const varName = camelCase(varNameSegs.join('-'));
        return `\${vars.${field}.${varName}}`;
      }

      if (string.startsWith('$')) {
        const varName = selectorToLiteral(string.slice(1));

        if (
          checkUpTree(
            root,
            decl,
            nodeToCheck => nodeToCheck.type === 'atrule' && nodeToCheck.name === 'mixin',
          )
          || root.nodes.some(node => node.prop === string)
        ) {
          return `\${${varName}}`;
        }

        if (!root.usesCustomVars) {
          root.usesCustomVars = true;
        }

        return `\${customVars.${varName}}`;
      }

      return string;
    })
    .join(' ');
}

function handleSassVarUnescaped(value) {
  if (value.startsWith(FE_BRARY_PREFIX)) {
    const [, name] = value.split(FE_BRARY_PREFIX);
    const [field, ...varNameSegs] = name.split('-');
    const varName = camelCase(varNameSegs.join('-'));
    return `vars.${field}.${varName}`;
  }

  if (value.startsWith('$')) {
    const varName = selectorToLiteral(value.slice(1));
    return `customVars.${varName}`;
  }

  const isWrappedInQuotes = ['"', "'"].includes(value[0]);
  if (isWrappedInQuotes) {
    return value;
  }

  // wrap in string quotes, e.g 100px => '100px'
  return `'${value}'`;
}

function placeHolderToVarRef(params) {
  return `\${${selectorToLiteral(params)}};`;
}

function mixinParamsToFunc(str) {
  if (!str.includes('(')) {
    return `${selectorToLiteral(str.trim())}()`;
  }

  const [funcName, inputs] = str.split('(');
  return `${selectorToLiteral(funcName)}(${inputs.replace(/\$/g, '')}`;
}

const processRoot = (root, filePath) => {
  root.feBraryHelpers = [];
  root.externalImports = [];
  root.classes = new Map();
  root.usesFeBraryVars = false;
  // move all three below to global scope and use stringify
  root.walkAtRules('extend', (atRule) => {
    atRule.originalParams = atRule.params;
    let hasRefInFile;
    root.walkRules(atRule.params, () => {
      hasRefInFile = true;
    });

    const ref = selectorToLiteral(atRule.params);

    if (!hasRefInFile) {
      // use fe-brary export to check and improve once done
      if (feBrary[ref] && typeof feBrary[ref] === 'object') {
        if (!root.feBraryHelpers.includes(ref)) root.feBraryHelpers.push(ref);
      } else if (!root.externalImports.includes(ref)) root.externalImports.push(ref);
    }

    atRule.params = placeHolderToVarRef(atRule.params);
  });

  root.walkAtRules('include', (atRule) => {
    atRule.originalParams = atRule.params;
    const [funcName, inputs] = atRule.params.split('(');

    // check for https://github.com/eduardoboucas/include-media
    if (atRule.nodes && atRule.nodes.length && atRule.params.trim().startsWith('media(')) {
      atRule.name = '__MEDIA_HELPER__';
      atRule.params = `\${${atRule.params.trim()}}`;
      if (!root.feBraryHelpers.includes('media')) root.feBraryHelpers.push('media');
      return;
    }

    let hasRefInFile;
    root.walkAtRules('mixin', (mixinDeclRule) => {
      const [mixinFuncName] = mixinDeclRule.params.split('(');
      if (mixinFuncName === funcName) hasRefInFile = true;
    });

    if (!hasRefInFile) {
      if (feBrary[funcName] && typeof feBrary[funcName] === 'function') {
        if (!root.feBraryHelpers.includes(selectorToLiteral(funcName))) {
          root.feBraryHelpers.push(selectorToLiteral(funcName));
        }
      } else if (!root.externalImports.includes(selectorToLiteral(funcName))) {
        root.externalImports.push(selectorToLiteral(funcName));
      }
    }

    if (!atRule.params.includes('(')) {
      atRule.params = `\${${selectorToLiteral(atRule.params.trim())}()}`;
      return;
    }

    const inputsWithoutBraces = inputs.slice(0, -1);
    const args = inputsWithoutBraces.split(',').map(arg => handleSassVarUnescaped(arg.trim()));

    atRule.params = `\${${selectorToLiteral(funcName.trim())} (${args.join(', ')})}`;
  });

  root.walkDecls((decl) => {
    if (decl.parent && decl.parent === root) {
      let isUsedInFile = false;
      // search all decl values for ref
      root.walkDecls((declSearch) => {
        if (declSearch === decl) return;
        if (
          declSearch.value
          && declSearch.value.includes(decl.prop)
          && declSearch.parent !== root
        ) {
          isUsedInFile = true;
        }
      });
      root.classes.set(decl.prop, {
        type: 'constVar',
        node: decl,
        isUsedInFile,
      });
      return;
    }

    if (OPERATORS.some(operator => decl.value.includes(operator))) {
      global.sassToEmotionWarnings[filePath] = global.sassToEmotionWarnings[filePath] || [];
      const msg = "Sass maths detected, find the FIXME's in this file and manually fix.";
      if (!global.sassToEmotionWarnings[filePath].includes(msg)) {
        global.sassToEmotionWarnings[filePath].push(msg);
      }
      decl.parent.insertBefore(
        decl,
        comment({
          text: 'FIXME: Sass maths was detected in the line below, you must fix manually.',
        }),
      );
    }

    decl.value = handleSassVar(decl, root);
  });

  root.walkRules(/^(?!(\.|%))/, (rule) => {
    if (rule.parent !== root) return;
    const msg = `Found a global selector "${
      rule.selector
    }". Do you need this? If you must use "import { Global } from '@emotion/core'".`;
    if (global.sassToEmotionWarnings[filePath]) {
      global.sassToEmotionWarnings[filePath].push(msg);
    } else {
      global.sassToEmotionWarnings[filePath] = [msg];
    }
  });

  // flattens nested rules
  root.walkRules(/^(\.|%)/, (rule) => {
    let { selector } = rule;
    let pseudoPostfix;

    if (rule.selector.includes(':')) {
      [selector, pseudoPostfix] = rule.selector.split(':');
    }

    const isPlaceHolder = rule.selector[0] === '%';

    let isUsedInFile = false;
    if (isPlaceHolder) {
      selector = selectorToLiteral(selector);
      // search to see if placeholder is used
      root.walkAtRules('extend', (atRule) => {
        // note atRule.params has already been modified
        if (atRule.originalParams === rule.selector) {
          isUsedInFile = true;
        }
      });
    } else {
      selector = selectorToLiteral(selector);
    }

    if (
      checkUpTree(
        root,
        rule,
        nodeToCheck => nodeToCheck.type === 'atrule' && nodeToCheck.name === 'mixin',
      )
    ) return;

    let contents = '';
    postcss.stringify(rule, (string, node, startOrEnd) => {
      if (node && node === rule && startOrEnd) return;

      const nestedInAmpersand = node
        && checkUpTree(
          root,
          node,
          nodeToCheck => nodeToCheck.type === 'rule' && nodeToCheck.selector.startsWith('&'),
        );

      if (node && node.name === '__MEDIA_HELPER__' && startOrEnd === 'start') {
        contents += `${node.params} {`;
        return;
      }

      // ref class if nested in ampersand
      if (
        node
        && node.type === 'rule'
        && startOrEnd === 'start'
        && !node.selector.startsWith('&')
        && nestedInAmpersand
      ) {
        contents += `css-\${${selectorToLiteral(node.selector)}.name} {`;
        return;
      }

      // ignore nested classes
      if (node && node.type === 'rule' && node.selector.startsWith('.') && !nestedInAmpersand) {
        return;
      }

      // don't print ampersand decls twice
      // if (
      //   node
      //   && node.type === 'decl'
      //   && node.parent
      //   && node.parent.selector
      //   && node.parent.selector.startsWith('&')
      //   && !checkUpTree(
      //     root,
      //     node,
      //     nodeToCheck => nodeToCheck.type === 'rule' && nodeToCheck.isItsOwnCssVar,
      //   )
      // ) return;

      // don't print nested decls
      if (
        node
        && node.parent.type === 'rule'
        && !nestedInAmpersand
        && node.parent !== rule
        && node.parent.selector.startsWith('.')
      ) return;

      // handle mixins and placeholder's
      if (node && ['extend', 'include'].includes(node.name)) {
        contents += node.params;
        return;
      }

      contents += string;
    });

    root.classes.set(selector, {
      type: isPlaceHolder ? 'placeholder' : 'class',
      isUsedInFile,
      contents: pseudoPostfix ? `&:${pseudoPostfix} { ${contents} }` : contents,
      node: rule,
    });
  });

  root.walkAtRules('mixin', (atRule) => {
    const { params } = atRule;
    const selector = mixinParamsToFunc(params);

    let contents = '';
    postcss.stringify(atRule, (string, node, startOrEnd) => {
      // if node.type === decl skip when doing this above
      // stops first and last part entering the string e.g "@mixin ad-exact($width, $height) {"
      if (node && node === atRule && startOrEnd) return;

      contents += string;
    });

    let isUsedInFile = false;
    // search to see if mixin is used in file
    root.walkAtRules('include', (rule) => {
      if (rule.originalParams.split('(')[0] === params.split('(')[0]) {
        isUsedInFile = true;
      }
    });

    root.classes.set(selector, {
      type: 'mixin',
      contents,
      isUsedInFile,
      node: atRule,
    });
  });
};

module.exports = (cssString, filePath, pathToVariables = '../variables') => {
  const root = postcss.parse(cssString, { from: filePath });

  processRoot(root, filePath);

  // e.g styles.scss
  const isJustSassImports = root.nodes.every(
    node => node.type === 'atrule' && node.name === 'import',
  );
  if (isJustSassImports) return null;

  let fileIsJustVarExports = true;

  const oneDefault = root.classes.size === 1;

  const emotionExports = Array.from(root.classes.entries())
    .sort(([, { node: a }], [, { node: b }]) => a.source.start.line - b.source.start.line)
    .reduce((acc, [name, {
      contents, type, node, isUsedInFile,
    }]) => {
      if (type !== 'constVar') {
        fileIsJustVarExports = false;
      }

      if (type === 'mixin') {
        return `${acc}\n${isUsedInFile ? '' : 'export '}${
          oneDefault ? ' default ' : ''
        }function ${name} {\n  return css\`${contents}\n  \`;\n}\n`;
      }

      if (type === 'constVar') {
        return `${acc}\n${isUsedInFile ? '' : 'export '}${
          oneDefault ? ' default ' : ` const ${selectorToLiteral(node.prop)} = `
        } ${
          node.value.includes("'")
            ? `"${node.value.replace('\n', ' ')}"`
            : `'${node.value.replace('\n', ' ')}'`
        }`;
      }

      return `${acc}\n${type === 'class' || !isUsedInFile ? 'export ' : ''}${
        oneDefault ? 'default ' : `const ${name} = `
      }css\`${contents}\`;\n`;
    }, '');

  const js = `${fileIsJustVarExports ? '' : "import { css } from '@emotion/core'"};\n${
    root.usesFeBraryVars
      ? `import { variables as vars${
        root.feBraryHelpers.length ? `, ${root.feBraryHelpers.join(', ')}` : ''
      } } from '@domain-group/fe-brary';\n`
      : ''
  }${
    !root.usesFeBraryVars && root.feBraryHelpers.length
      ? `import { ${root.feBraryHelpers.join(', ')} } from '@domain-group/fe-brary';\n`
      : ''
  }${
    root.externalImports.length
      ? `import { ${root.externalImports.join(', ')} } from '../utils';\n`
      : ''
  }${
    root.usesCustomVars ? `import * as customVars from '${pathToVariables}';\n` : ''
  }${emotionExports}
`;

  return format({ text: js, filePath, prettierOptions: { parser: 'babylon' } });
};
