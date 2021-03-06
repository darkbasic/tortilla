var Fs = require('fs-extra');
var Path = require('path');
var Tmp = require('tmp');
var Git = require('./git');
var LocalStorage = require('./local-storage');
var Manual = require('./manual');
var Paths = require('./paths');
var Step = require('./step');
var Utils = require('./utils');

/**
  The 'release' module contains different utilities and methods which are responsible
  for release management. Before invoking any method, be sure to fetch **all** the step
  tags from the git-host, since most calculations are based on them.
 */

var tmp1Dir = Tmp.dirSync({ unsafeCleanup: true });
var tmp2Dir = Tmp.dirSync({ unsafeCleanup: true });


// Creates a bumped release tag of the provided type
// e.g. if the current release is @1.0.0 and we provide this function with a release type
// of 'patch', the new release would be @1.0.1
function bumpRelease(releaseType, options) {
  options = options || {};

  var currentRelease = getCurrentRelease();

  // Increase release type
  switch (releaseType) {
    case 'major':
      currentRelease.major++;
      currentRelease.minor = 0;
      currentRelease.patch = 0;
      break;
    case 'minor':
      currentRelease.minor++;
      currentRelease.patch = 0;
      break;
    case 'patch':
      currentRelease.patch++;
      break;
    default:
      throw Error('Provided release type must be one of "major", "minor" or "patch"');
  }

  try {
    // Store potential release so it can be used during rendering
    LocalStorage.setItem('POTENTIAL_RELEASE', JSON.stringify(currentRelease));
    // Render manuals before bumping version to make sure the views are correlated with
    // the templates
    Manual.render('all');
  }
  finally {
    LocalStorage.removeItem('POTENTIAL_RELEASE');
  }

  var branch = Git.activeBranchName();
  // The formatted release e.g. 1.0.0
  var formattedRelease = formatRelease(currentRelease);

  // Extract root data
  var rootHash = Git.rootHash();
  var rootTag = [branch, 'root', formattedRelease].join('@');

  // Create root tag
  // e.g. master@root@1.0.1
  Git(['tag', rootTag, rootHash]);

  // Create a release tag for each super step
  Git([
    // Log commits
    'log',
    // Specifically for steps
    '--grep', '^Step [0-9]\\+:',
    // Formatted with their subject followed by their hash
    '--format=%s %H'
  ]).split('\n')
    .filter(Boolean)
    .forEach(function (line) {
      // Extract data
      var words = line.split(' ');
      var hash = words.pop();
      var subject = words.join(' ');
      var descriptor = Step.descriptor(subject);
      var tag = [branch, 'step' + descriptor.number, formattedRelease].join('@');

      // Create tag
      // e.g. master@step1@1.0.1
      Git(['tag', tag, hash])
    });

  var tag = branch + '@' + formattedRelease;

  // Create a tag with the provided message which will reference to HEAD
  // e.g. 'master@1.0.1'
  if (options.message)
    Git.print(['tag', tag, 'HEAD', '-m', options.message]);
  // If no message provided, open the editor
  else
    Git.print(['tag', tag, 'HEAD', '-a']);

  createDiffReleasesBranch();
  printCurrentRelease();
}

// Creates a branch that represents a list of our releases, this way we can view any
// diff combination in the git-host
function createDiffReleasesBranch() {
  var destinationDir = createDiffReleasesRepo();
  var sourceDir = destinationDir == tmp1Dir.name ? tmp2Dir.name : tmp1Dir.name;

  // e.g. master
  var currBranch = Git.activeBranchName();
  // e.g. master-history
  var historyBranch = currBranch + '-history';

  // Make sure source is empty
  Fs.emptyDirSync(sourceDir);

  // Create dummy repo in source
  Git(['init', sourceDir, '--bare']);
  Git(['checkout', '-b', historyBranch], { cwd: destinationDir });
  Git(['push', sourceDir, historyBranch], { cwd: destinationDir });

  // Pull the newly created project to the branch name above
  if (Git.tagExists(historyBranch)) Git(['branch', '-D', historyBranch]);
  Git(['fetch', sourceDir, historyBranch]);
  Git(['branch', historyBranch, 'FETCH_HEAD']);

  // Clear registers
  tmp1Dir.removeCallback();
  tmp2Dir.removeCallback();
}

// Invokes 'git diff' with the given releases. An additional arguments vector which will
// be invoked as is may be provided
function diffRelease(sourceRelease, destinationRelease, argv) {
  argv = argv || [];

  var branch = Git.activeBranchName();
  // Compose tags
  var sourceReleaseTag = branch + '@' + sourceRelease;
  var destinationReleaseTag = branch + '@' + destinationRelease;
  // Create repo
  var destinationDir = createDiffReleasesRepo(sourceReleaseTag, destinationReleaseTag);

  // Run 'diff' between the newly created commits
  Git.print(['diff', 'HEAD^', 'HEAD'].concat(argv), { cwd: destinationDir });

  // Clear registers
  tmp1Dir.removeCallback();
  tmp2Dir.removeCallback();
}

// Creates the releases diff repo in a temporary dir. The result will be a path for the
// newly created repo
function createDiffReleasesRepo() {
  var tags = [].slice.call(arguments);

  if (tags.length == 0) {
    var branch = Git.activeBranchName();

    // Fetch all releases in reversed order, since the commits are going to be stacked
    // in the opposite order
    tags = getAllReleases()
      .map(formatRelease)
      .reverse()
      .map(function (releaseString) {
        return branch + '@' + releaseString;
      });
  }

  // The 'registers' are directories which will be used for temporary FS calculations
  var destinationDir = tmp1Dir.name;
  var sourceDir = tmp2Dir.name;

  // Make sure register2 is empty
  Fs.emptyDirSync(sourceDir);

  // Initialize an empty git repo in register2
  Git(['init'], { cwd: sourceDir });

  // Start building the diff-branch by stacking releases on top of each-other
  return tags.reduce(function (registers, tag, index) {
    sourceDir = registers[0];
    destinationDir = registers[1];
    sourcePaths = Paths.resolveProject(sourceDir);
    destinationPaths = Paths.resolveProject(destinationDir);

    // Make sure destination is empty
    Fs.emptyDirSync(destinationDir);

    // Copy current git dir to destination
    Fs.copySync(Paths.git.resolve(), destinationPaths.git.resolve(), {
      filter: function (filePath) {
        return filePath.split('/').indexOf('.tortilla') == -1;
      }
    });

    // Checkout release
    Git(['checkout', tag], { cwd: destinationDir });
    Git(['checkout', '.'], { cwd: destinationDir });

    // Copy destination to source, but without the git dir so there won't be any
    // conflicts with the commits
    Fs.removeSync(destinationPaths.git.resolve());
    Fs.copySync(sourcePaths.git.resolve(), destinationPaths.git.resolve());

    // Add commit for release
    Git(['add', '.'], { cwd: destinationDir });
    Git(['add', '-u'], { cwd: destinationDir });

    // Extracting tag message
    var tagLine = Git(['tag', '-l', tag, '-n99']);
    var tagMessage = tagLine.replace(/([^\s]+)\s+((?:.|\n)+)/, '$1: $2');

    // Creating a new commit with the tag's message
    Git(['commit', '-m', tagMessage, '--allow-empty'], {
      cwd: destinationDir
    });

    return registers.reverse();
  }, [
    sourceDir, destinationDir
  ]).shift();
}

function printCurrentRelease() {
  var currentRelease = getCurrentRelease();
  var formattedRelease = formatRelease(currentRelease);
  var branch = Git.activeBranchName();

  console.log();
  console.log('🌟 Release: ' + formattedRelease);
  console.log('🌟 Branch:  ' + branch);
  console.log();
}

// Gets the current release based on the latest release tag
// e.g. if we have the tags 'master@0.0.1', 'master@0.0.2' and 'master@0.1.0' this method
// will return { major: 0, minor: 1, patch: 0 }
function getCurrentRelease() {
  // Return potential release, if defined
  var potentialRelease = LocalStorage.getItem('POTENTIAL_RELEASE');

  if (potentialRelease) return JSON.parse(potentialRelease);

  // If release was yet to be released, assume this is a null release
  return getAllReleases()[0] || {
    major: 0,
    minor: 0,
    patch: 0
  };
}

// Gets a list of all the releases represented as JSONs e.g.
// [{ major: 0, minor: 1, patch: 0 }]
function getAllReleases() {
  var branch = Git.activeBranchName();

  return Git(['tag'])
    // Put tags into an array
    .split('\n')
    // If no tags found, filter the empty string
    .filter(Boolean)
    // Filter all the release tags which are proceeded by their release
    .filter(function (tagName) {
      var pattern = new RegExp(branch + '@\\d+\\.\\d+\\.\\d+');
      return tagName.match(pattern);
    })
    // Map all the release strings
    .map(function (tagName) {
      return tagName.split('@').pop();
    })
    // Deformat all the releases into a json so it would be more comfortable to work with
    .map(function (releaseString) {
      return deformatRelease(releaseString);
    })
    // Put the latest release first
    .sort(function (a, b) {
      return (
        (b.major - a.major) ||
        (b.minor - a.minor) ||
        (b.patch - a.patch)
      );
    });
}

// Takes a release json and puts it into a pretty string
// e.g. { major: 1, minor: 1, patch: 1 } -> '1.1.1'
function formatRelease(releaseJson) {
  return [
    releaseJson.major,
    releaseJson.minor,
    releaseJson.patch
  ].join('.');
}

// Takes a release string and puts it into a pretty json object
// e.g. '1.1.1' -> { major: 1, minor: 1, patch: 1 }
function deformatRelease(releaseString) {
  var releaseSlices = releaseString.split('.').map(Number);

  return {
    major: releaseSlices[0],
    minor: releaseSlices[1],
    patch: releaseSlices[2]
  };
}


module.exports = {
  bump: bumpRelease,
  createDiffBranch: createDiffReleasesBranch,
  printCurrent: printCurrentRelease,
  current: getCurrentRelease,
  all: getAllReleases,
  diff: diffRelease,
  format: formatRelease,
  deformat: deformatRelease
};