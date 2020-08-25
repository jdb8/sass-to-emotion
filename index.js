#!/usr/bin/env node
/* eslint-disable no-param-reassign, no-console */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const transform = require('./transform');

function scssFileToJs(filePath) {
  const newFilePath = filePath.replace('/scss/', '/styles/').replace('.scss', '.emotion.js');
  const filenewFilePathDir = path.dirname(newFilePath);
  const filenewFilePathBase = path.basename(newFilePath);

  // remove the Sass underscore _ (what a silly design decision)
  return path.join(filenewFilePathDir, filenewFilePathBase.replace('_', ''));
}

(() => {
  const files = process.argv.slice(2);
  global.sassToEmotionWarnings = {};
  console.log(chalk.bold.magentaBright(`Transforming ${files.length} files...`));
  const processedFiles = files
    .map((filePath) => {
      const css = fs.readFileSync(filePath);

      const pathToVariables = path.relative(
        path.dirname(scssFileToJs(path.resolve(filePath))),
        path.join(process.cwd(), 'src', 'styles'),
      );

      const js = transform(
        css,
        filePath,
        pathToVariables ? path.join(pathToVariables, 'variables') : './variables',
      );

      if (!js) return null;

      return [filePath, js];
    })
    .filter(Boolean);

  console.log(chalk.bold.magentaBright('Processed all files without errors, writing to disk.'));

  processedFiles.forEach(([filePath, js]) => {
    const finalFilePath = scssFileToJs(filePath);

    fs.mkdirSync(path.dirname(finalFilePath), { recursive: true });
    fs.writeFileSync(finalFilePath, js);
  });

  const hasWarnings = Object.keys(global.sassToEmotionWarnings).length;

  console.log(chalk.bold.magentaBright(`Finished successfully${hasWarnings ? ' but has warnings' : ''}!\n\n`));

  if (hasWarnings) {
    console.warn('The following files have warnings...\n\n');

    Object.entries(global.sassToEmotionWarnings).forEach(([key, value]) => {
      console.log(chalk.bold.underline(`${key}\n`));
      value.forEach((msg) => {
        console.log(chalk.red(`- ${msg}\n`));
      });
      console.log();
    });
  }

  process.exit();
})();
