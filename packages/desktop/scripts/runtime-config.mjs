export const DEFAULT_HERMES_VERSION = '0.23.0'
export const DEFAULT_HERMES_SOURCE_REPOSITORY = 'https://github.com/NousResearch/hermes-agent.git'
export const DEFAULT_HERMES_SOURCE_REF = 'v0.23.0'
export const DEFAULT_HERMES_SOURCE_COMMIT = '2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19'

export function hermesVersion(env = process.env) {
  return env.HERMES_VERSION || DEFAULT_HERMES_VERSION
}

export function runtimeVersion(env = process.env) {
  const value = (env.EKKO_RUNTIME_VERSION || hermesVersion(env)).trim().replace(/^v/, '')
  if (!value || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value)) {
    throw new Error('EKKO_RUNTIME_VERSION must be a non-empty release identifier')
  }
  return value
}

export function hermesSource(env = process.env) {
  const version = hermesVersion(env).trim()
  const repository = (
    env.HERMES_SOURCE_REPOSITORY
    || DEFAULT_HERMES_SOURCE_REPOSITORY
  ).trim()
  const ref = (env.HERMES_SOURCE_REF || DEFAULT_HERMES_SOURCE_REF).trim()
  const commit = (env.HERMES_SOURCE_COMMIT || DEFAULT_HERMES_SOURCE_COMMIT).trim().toLowerCase()

  const releaseOverridePresent = Boolean(
    env.HERMES_VERSION?.trim()
    || env.HERMES_SOURCE_REF?.trim()
    || env.HERMES_SOURCE_COMMIT?.trim(),
  )
  if (releaseOverridePresent) {
    const missing = [
      ['HERMES_VERSION', env.HERMES_VERSION],
      ['HERMES_SOURCE_REF', env.HERMES_SOURCE_REF],
      ['HERMES_SOURCE_COMMIT', env.HERMES_SOURCE_COMMIT],
    ]
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name)
    if (missing.length > 0) {
      throw new Error(
        `Hermes source overrides are atomic; missing ${missing.join(', ')}`,
      )
    }
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('HERMES_SOURCE_COMMIT must be a full 40-character Git commit')
  }
  if (!version || !repository || !ref) {
    throw new Error('Hermes source version, repository, and ref must be non-empty')
  }

  return { version, repository, ref, commit }
}

export function runtimeReleaseTag(env = process.env) {
  const version = runtimeVersion(env)
  return env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
    || env.RUNTIME_RELEASE_TAG
    || `hermes-${version}-runtime`
}
