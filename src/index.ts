import logger from '@pnpm/logger'
import got = require('got')
import git = require('graceful-git')
import normalizeSsh = require('normalize-ssh')
import path = require('path')
import semver = require('semver')
import parsePref, {HostedPackageSpec} from './parsePref'

export {HostedPackageSpec}

const gitLogger = logger // TODO: add namespace 'git-logger'

let tryGitHubApi = true

export default function (
  opts: {},
) {
  return async function resolveGit (
    wantedDependency: {pref: string},
  ): Promise<{
    id: string,
    normalizedPref: string,
    resolution: ({commit: string, repo: string, type: 'git'} | {tarball: string}),
  } | null> {
    const parsedSpec = parsePref(wantedDependency.pref)

    if (!parsedSpec) return null

    const isGitHubHosted = parsedSpec.hosted && parsedSpec.hosted.type === 'github'

    if (!isGitHubHosted || isSsh(wantedDependency.pref)) {
      const commit = await resolveRef(parsedSpec.fetchSpec, parsedSpec.gitCommittish || 'master', parsedSpec.gitRange)
      return {
        id: parsedSpec.fetchSpec
          .replace(/^.*:\/\/(git@)?/, '')
          .replace(/:/g, '+')
          .replace(/\.git$/, '') + '/' + commit,
        normalizedPref: parsedSpec.normalizedPref,
        resolution: {
          commit,
          repo: parsedSpec.fetchSpec,
          type: 'git',
        },
      }
    }

    const parts = normalizeRepoUrl(parsedSpec).split('#')
    const repo = parts[0]

    const ghSpec = {
      project: parsedSpec.hosted!.project,
      ref: parsedSpec.hosted!.committish || 'master',
      user: parsedSpec.hosted!.user,
    }
    let commitId: string
    if (tryGitHubApi) {
      try {
        commitId = resolveRefFromRefs(await tryResolveViaGitHubApi(ghSpec), repo, ghSpec.ref, parsedSpec.gitRange)
      } catch (err) {
        gitLogger.warn({
          err,
          message: `Error while trying to resolve ${parsedSpec.fetchSpec} via GitHub API`,
        })

        // if it fails once, don't bother retrying for other packages
        tryGitHubApi = false

        commitId = await resolveRef(repo, parsedSpec.gitCommittish || 'master', parsedSpec.gitRange)
      }
    } else {
      commitId = await resolveRef(repo, parsedSpec.gitCommittish || 'master', parsedSpec.gitRange)
    }

    const tarballResolution = {
      tarball: `https://codeload.github.com/${ghSpec.user}/${ghSpec.project}/tar.gz/${commitId}`,
    }
    return {
      id: ['github.com', ghSpec.user, ghSpec.project, commitId].join('/'),
      normalizedPref: parsedSpec.normalizedPref,
      resolution: tarballResolution,
    }
  }
}

function resolveVTags (vTags: string[], range: string) {
  return semver.maxSatisfying(vTags, range, true)
}

async function getRepoRefs (repo: string) {
  const result = await git(['ls-remote', '--refs', repo])
  const refs = result.stdout.split('\n').reduce((obj: object, line: string) => {
    const commitAndRef = line.split('\t')
    const commit = commitAndRef[0]
    const ref = commitAndRef[1]
    obj[ref] = commit
    return obj
  }, {})
  return refs
}

async function resolveRef (repo: string, ref: string, range?: string) {
  const refs = await getRepoRefs(repo)
  return resolveRefFromRefs(refs, repo, ref, range)
}

function resolveRefFromRefs (refs: {[ref: string]: string}, repo: string, ref: string, range?: string) {
  if (!range) {
    const commitId =
      refs[ref] ||
      refs[`refs/tags/${ref}^{}`] || // prefer annotated tags
      refs[`refs/tags/${ref}`] ||
      refs[`refs/heads/${ref}`] ||
      (ref.match(/^[0-9a-f]{40}/) || [])[0]

    if (!commitId) {
      throw new Error(`Could not resolve ${ref} to a commit of ${repo}.`)
    }

    return commitId
  } else {
    const vTags =
      Object.keys(refs)
        // using the same semantics of version tags as https://github.com/zkat/pacote
      .filter((key: string) => /^refs\/tags\/v?(\d+\.\d+\.\d+(?:[-+].+)?)(\^{})?$/.test(key))
      .map((key: string) => {
        return key
          .replace(/^refs\/tags\//, '')
          .replace(/\^{}$/, '') // accept annotated tags
      })
      .filter((key: string) => semver.valid(key, true))
    const refVTag = resolveVTags(vTags, range)
    const commitId = refVTag &&
      (refs[`refs/tags/${refVTag}^{}`] || // prefer annotated tags
      refs[`refs/tags/${refVTag}`])

    if (!commitId) {
      throw new Error(`Could not resolve ${range} to a commit of ${repo}. Available versions are: ${vTags.join(', ')}`)
    }

    return commitId
  }
}

function normalizeRepoUrl (parsedSpec: HostedPackageSpec) {
  const hosted = <any>parsedSpec.hosted // tslint:disable-line
  return hosted.getDefaultRepresentation() === 'shortcut' ? hosted.git() : hosted.toString()
}

function isSsh (gitSpec: string): boolean {
  return gitSpec.substr(0, 10) === 'git+ssh://'
    || gitSpec.substr(0, 4) === 'git@'
}

/**
 * Resolves a 'hosted' package hosted on 'github'.
 */
async function tryResolveViaGitHubApi (
  spec: {
    user: string,
    project: string,
  },
) {
  const url = `https://api.github.com/repos/${spec.user}/${spec.project}/git/refs`
  const response = await got(url, {json: true})
  return response.body.reduce((acc: object, refInfo: RefInfo) => {
    acc[refInfo.ref] = refInfo.object.sha
    return acc
  }, {})
}

interface RefInfo {
  ref: string,
  url: string,
  object: {
    sha: string,
    type: 'commit' | 'tag',
    url: string,
  },
}
