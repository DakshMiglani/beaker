import {app} from 'electron'
import * as dft from 'diff-file-tree'
import * as diff from 'diff'
import anymatch from 'anymatch'
import fs from 'fs'
import path from 'path'
import EventEmitter from 'events'
import * as settingsDb from '../../dbs/settings'
import {isFileNameBinary, isFileContentBinary} from '../../../lib/mime'
import * as scopedFSes from '../../../lib/bg/scoped-fses'
import {
  NotFoundError,
  NotAFolderError,
  ProtectedFileNotWritableError,
  ArchiveNotWritableError,
  InvalidEncodingError,
  SourceTooLargeError
} from 'beaker-error-constants'

const DISALLOWED_SAVE_PATH_NAMES = [
  'home',
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos'
]

// exported api
// =

export var events = new EventEmitter()

// sync dat to the folder
// - opts
//   - shallow: bool, dont descend into changed folders (default true)
//   - compareContent: bool, compare the actual content (default true)
//   - paths: Array<string>, a whitelist of files to compare
//   - localSyncPath: string, override the archive localSyncPath
//   - addOnly: bool, dont modify or remove any files (default false)
export function syncArchiveToFolder (archive, opts = {}) {
  if (archive.syncFolderToArchiveTimeout) return console.log('Not running, locked')
  return sync(archive, false, opts)
}

// sync folder to the dat
// - opts
//   - shallow: bool, dont descend into changed folders (default true)
//   - compareContent: bool, compare the actual content (default true)
//   - paths: Array<string>, a whitelist of files to compare
//   - localSyncPath: string, override the archive localSyncPath
//   - addOnly: bool, dont modify or remove any files (default false)
export function syncFolderToArchive (archive, opts = {}) {
  if (!archive.writable) throw new ArchiveNotWritableError()
  return sync(archive, true, opts)
}

// attach/detach a watcher on the local folder and sync it to the dat
export function configureFolderToArchiveWatcher (archive) {
  console.log('configureFolderToArchiveWatcher()', archive.localSyncPath, !!archive.stopWatchingLocalFolder)

  if (archive.stopWatchingLocalFolder) {
    // stop watching
    archive.stopWatchingLocalFolder()
    archive.stopWatchingLocalFolder = null
  }
 
  if (archive.localSyncPath) {
    // start watching
    var scopedFS = scopedFSes.get(archive.localSyncPath)
    archive.stopWatchingLocalFolder = scopedFS.watch('/', path => {
      console.log('changed detected', path)
      // disable sync-to-folder for 5 seconds
      if (archive.syncFolderToArchiveTimeout) {
        clearTimeout(archive.syncFolderToArchiveTimeout)
      }
      archive.syncFolderToArchiveTimeout = setTimeout(async () => {
        console.log('ok timed out')
        await syncFolderToArchive(archive, {shallow: false})
        archive.syncFolderToArchiveTimeout = null
      }, 1e3)
    })
  }
}

// list the files that differ
// - opts
//   - shallow: bool, dont descend into changed folders (default true)
//   - compareContent: bool, compare the actual content (default true)
//   - paths: Array<string>, a whitelist of files to compare
//   - localSyncPath: string, override the archive localSyncPath
export async function diffListing (archive, opts={}) {
  var localSyncPath = opts.localSyncPath || archive.localSyncPath
  if (!localSyncPath) return // sanity check
  var scopedFS = scopedFSes.get(localSyncPath)
  opts = massageDiffOpts(opts)

  // build ignore rules
  if (opts.paths) {
    opts.filter = makeDiffFilterByPaths(opts.paths)
  } else {
    const ignoreRules = await readDatIgnore(scopedFS)
    opts.filter = (filepath) => anymatch(ignoreRules, filepath)
  }

  // run diff
  return dft.diff({fs: scopedFS}, {fs: archive}, opts)
}

// diff an individual file
// - filepath: string, the path of the file in the archive/folder
export async function diffFile (archive, filepath) {
  if (!archive.localSyncPath) return // sanity check
  var scopedFS = scopedFSes.get(archive.localSyncPath)
  filepath = path.normalize(filepath)

  // check the filename to see if it's binary
  var isBinary = isFileNameBinary(filepath)
  if (isBinary === true) {
    throw new InvalidEncodingError('Cannot diff a binary file')
  }

  // make sure we can handle the buffers involved
  let st
  st = await stat(scopedFS, filepath)
  if (isBinary !== false && st && st.isFile() && await isFileContentBinary(scopedFS, filepath)) {
    throw new InvalidEncodingError('Cannot diff a binary file')
  }
  if (st && st.isFile() && st.size > MAX_DIFF_SIZE) {
    throw new SourceTooLargeError()
  }
  st = await stat(archive, filepath)
  if (isBinary !== false && st && st.isFile() && await isFileContentBinary(archive, filepath)) {
    throw new InvalidEncodingError('Cannot diff a binary file')
  }
  if (st && st.isFile() && st.size > MAX_DIFF_SIZE) {
    throw new SourceTooLargeError()
  }

  // read the file in both sources
  const [newFile, oldFile] = await Promise.all([readFile(scopedFS, filepath), readFile(archive, filepath)])

  // return the diff
  return diff.diffLines(oldFile, newFile)
}

// validate a path to be used for sync
export async function assertSafePath (p) {
  // check whether this is an OS path
  for (let i = 0; i < DISALLOWED_SAVE_PATH_NAMES.length; i++) {
    let disallowedSavePathName = DISALLOWED_SAVE_PATH_NAMES[i]
    let disallowedSavePath = app.getPath(disallowedSavePathName)
    if (path.normalize(p) === path.normalize(disallowedSavePath)) {
      throw new ProtectedFileNotWritableError(`This is the OS ${disallowedSavePathName} folder, which is protected. Please pick another folder or subfolder.`)
    }
  }

  // stat the folder
  const stat = await new Promise(resolve => {
    fs.stat(p, (err, st) => resolve(st))
  })

  if (!stat) {
    throw new NotFoundError()
  }

  if (!stat.isDirectory()) {
    throw new NotAFolderError('Invalid target folder: not a folder')
  }
}

// read a datignore from a fs space and turn it into anymatch rules
export async function readDatIgnore (fs) {
  var rulesRaw = await readFile(fs, '.datignore')
  if (!rulesRaw) {
    rulesRaw = await settingsDb.get('default_dat_ignore')
  }
  return rulesRaw.split('\n')
    .filter(Boolean)
    .map(rule => {
      if (!rule.startsWith('/')) {
        rule = '**/' + rule
      }
      return rule
    })
    .concat(['/.git', '/.dat'])
    .map(path.normalize)
}

// put the dat.json into the folder and then merge files, with preference to folder files
export async function mergeArchiveAndFolder (archive, localSyncPath) {
  await sync(archive, false, {localSyncPath, paths: ['/dat.json']}) // archive dat.json -> folder
  await sync(archive, false, {localSyncPath, shallow: false, addOnly: true}) // archive -> folder (add-only)
  await sync(archive, true, {localSyncPath, shallow: false}) // folder -> archive
}

// internal methods
// =

// sync the dat & folder content
// - toArchive: true to sync folder to archive, false to sync archive to folder
// - opts
//   - shallow: bool, dont descend into changed folders (default true)
//   - compareContent: bool, compare the actual content (default true)
//   - paths: Array<string>, a whitelist of files to compare
//   - localSyncPath: string, override the archive localSyncPath
//   - addOnly: bool, dont modify or remove any files (default false)
async function sync (archive, toArchive, opts = {}) {
  var localSyncPath = opts.localSyncPath || archive.localSyncPath
  if (!localSyncPath) return // sanity check
  var scopedFS = scopedFSes.get(localSyncPath)
  opts = massageDiffOpts(opts)

  // build ignore rules
  if (opts.paths) {
    opts.filter = makeDiffFilterByPaths(opts.paths)
  } else {
    let ignoreRules = await readDatIgnore(scopedFS)
    opts.filter = (filepath) => anymatch(ignoreRules, filepath)
  }

  // choose direction
  var left = toArchive ? {fs: scopedFS} : {fs: archive}
  var right = toArchive ? {fs: archive} : {fs: scopedFS}

  // run diff
  var diff = await dft.diff(left, right, opts)
  if (opts.addOnly) {
    diff = diff.filter(d => d.change === 'add')
  }
  console.log('syncing to', toArchive ? 'archive' : 'folder', diff) // DEBUG

  // sync data
  await dft.applyRight(left, right, diff)
  events.emit('sync', archive.key, toArchive ? 'archive' : 'folder')
}

function makeDiffFilterByPaths (targetPaths) {
  targetPaths = targetPaths.map(path.normalize)
  return (filepath) => {
    for (let i = 0; i < targetPaths.length; i++) {
      let targetPath = targetPaths[i]

      if (targetPath.endsWith(path.sep)) {
        // a directory
        if (filepath === targetPath.slice(0, -1)) return false // the directory itself
        if (filepath.startsWith(targetPath)) return false // a file within the directory
      } else {
        // a file
        if (filepath === targetPath) return false
      }
      if (targetPath.startsWith(filepath) && targetPath.charAt(filepath.length) === '/') {
        return false // a parent folder
      }

    }
    return true
  }
}

function massageDiffOpts (opts) {
  return {
    compareContent: typeof opts.compareContent === 'boolean' ? opts.compareContent : true,
    shallow: typeof opts.shallow === 'boolean' ? opts.shallow : true,
    paths: Array.isArray(opts.paths) ? opts.paths.filter(v => typeof v === 'string') : false,
    addOnly: typeof opts.addOnly === 'boolean' ? opts.addOnly : false
  }
}

// helper to read a file via promise and return a null on fail
async function stat (fs, filepath) {
  return new Promise(resolve => {
    fs.stat(filepath, (err, data) => {
      resolve(data || null)
    })
  })
}

// helper to read a file via promise and return an empty string on fail
async function readFile (fs, filepath) {
  return new Promise(resolve => {
    fs.readFile(filepath, {encoding: 'utf8'}, (err, data) => {
      resolve(data || '')
    })
  })
}
