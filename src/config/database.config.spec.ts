import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('database config environment loading', () => {
  const originalCwd = process.cwd()
  const originalNodeEnv = process.env.NODE_ENV
  const databaseKeys = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE'] as const
  const originalValues = new Map(databaseKeys.map(key => [key, process.env[key]]))
  let fixtureDir: string

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'nest-admin-database-config-'))
    process.chdir(fixtureDir)
    process.env.NODE_ENV = 'development'
    for (const key of databaseKeys)
      delete process.env[key]
    jest.resetModules()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalNodeEnv === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = originalNodeEnv
    for (const key of databaseKeys) {
      const value = originalValues.get(key)
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('loads local and base env files before eagerly creating the data source', async () => {
    writeFileSync('.env.local', 'DB_HOST=127.0.0.2\nDB_USERNAME=local-user\nDB_PASSWORD=local-password\n')
    writeFileSync('.env', 'DB_HOST=127.0.0.1\nDB_PORT=3307\nDB_USERNAME=base-user\nDB_PASSWORD=base-password\nDB_DATABASE=nest_admin\n')

    const { default: dataSource } = await import('./database.config')

    expect(dataSource.options).toEqual(expect.objectContaining({
      host: '127.0.0.2',
      port: 3307,
      username: 'local-user',
      password: 'local-password',
      database: 'nest_admin',
    }))
  })
})
