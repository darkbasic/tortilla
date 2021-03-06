var Fs = require('fs-extra');
var Handlebars = require('handlebars');
var Path = require('path');
var ReadlineSync = require('readline-sync');
var Tmp = require('tmp');
var Ascii = require('./ascii');
var Rebase = require('./rebase');
var Git = require('./git');
var LocalStorage = require('./local-storage');
var Paths = require('./paths');
var Utils = require('./utils');

/**
  Contains some essential utilities that should usually run once to create a project or
  initialize a project.
 */

var tmpDir = Tmp.dirSync({ unsafeCleanup: true });
var tmpPaths = Paths.resolveProject(tmpDir.name);
var exec = Utils.exec;


(function () {
  if (require.main !== module) return;

  var argv = Minimist(process.argv.slice(2), {
    string: ['_', 'message', 'm', 'output', 'o'],
    boolean: ['override']
  });

  var method = argv._[0];
  var arg1 = argv._[1];
  var output = argv.output || argv.o;
  var override = argv.override;

  var options = {
    output: output,
    override: override
  };

  switch (method) {
    case 'create': return createProject(arg1, options);
    case 'init': return initializeProject(arg1);
  }
})();

// Initialize tortilla project, it will use the skeleton as the template and it will fill
// it up with the provided details. Usually should only run once
function createProject(projectName, options) {
  projectName = projectName || 'tortilla-project';

  options = Utils.extend({
    output: Path.resolve(projectName)
  }, options);

  // In case dir already exists verify the user's decision
  if (Utils.exists(options.output)) {
    options.override = options.override || ReadlineSync.keyInYN([
      'Output path already eixsts.',
      'Would you like to override it and continue?'
    ].join('\n'));

    if (!options.override) return;
  }

  Fs.removeSync(tmpDir.name);
  // Clone skeleton
  Git.print(['clone', Paths.tortilla.skeleton, tmpDir.name], { cwd: '/tmp' });
  // Checkout desired release
  Git.print(['checkout', '0.0.1-alpha.4'], { cwd: tmpDir.name });
  // Remove .git to remove unnecessary meta-data, git essentials should be
  // initialized later on
  Fs.removeSync(tmpPaths.git.resolve());

  var packageName = Utils.kebabCase(projectName);
  var title = Utils.startCase(projectName);

  // Fill in template files
  overwriteTemplateFile(tmpPaths.npm.package, {
    name: packageName
  });

  overwriteTemplateFile(tmpPaths.readme, {
    title: title
  });

  // Git chores
  Git(['init'], { cwd: tmpDir.name });
  Git(['add', '.'], { cwd: tmpDir.name });
  Git(['commit', '-m', title], { cwd: tmpDir.name });

  if (options.message)
    Git.print(['commit', '--amend', '-m', options.message], { cwd: tmpDir.name });
  else
    Git.print(['commit', '--amend'], { cwd: tmpDir.name });

  // Initializing
  ensureTortilla(tmpPaths);

  // Copy from temp to output
  Fs.removeSync(options.output);
  Fs.copySync(tmpDir.name, options.output);
  tmpDir.removeCallback();
}

// Make sure that tortilla essentials are initialized on an existing project.
// Used most commonly when cloning or creating a project
function ensureTortilla(projectDir) {
  projectDir = projectDir || Utils.cwd();

  var projectPaths = projectDir.resolve ? projectDir : Paths.resolveProject(projectDir);
  var localStorage = LocalStorage.create(projectPaths);

  // If tortilla is already initialized don't do anything
  var isInitialized = localStorage.getItem('INIT');
  if (isInitialized) return;

  var hookFiles = Fs.readdirSync(projectPaths.tortilla.hooks);

  // For each hook file in the hooks directory
  hookFiles.forEach(function (hookFile) {
    var handlerPath = Path.resolve(projectPaths.tortilla.hooks, hookFile);
    var hookName = Path.basename(hookFile, '.js');
    var hookPath = Path.resolve(projectPaths.git.hooks, hookName);

    // Place an executor in the project's git hooks
    var hook = [
      '',
      '# Tortilla',
      'cd .',
      'node ' + handlerPath + ' "$@"'
    ].join('\n');

    // If exists, append logic
    if (Utils.exists(hookPath, 'file'))
      Fs.appendFileSync(hookPath, '\n' + hook);
    // Else, create file
    else
      Fs.writeFileSync(hookPath, '#!/bin/sh' + hook);

    // Give read permissions to hooks so git can execute properly
    Fs.chmodSync(hookPath, 0755);
  });

  // Mark tortilla flag as initialized
  localStorage.setItem('INIT', true);
  localStorage.setItem('USE_STRICT', true);

  Ascii.print('ready');
}

function overwriteTemplateFile(path, scope) {
  var templateContent = Fs.readFileSync(path, 'utf8');
  var viewContent = Handlebars.compile(templateContent)(scope);

  Fs.writeFileSync(path, viewContent);
}


module.exports = {
  create: createProject,
  ensure: ensureTortilla
};