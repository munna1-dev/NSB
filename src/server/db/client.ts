import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

let pool: Pool | undefined

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL is not configured')
  return value
}

function getTlsConfig() {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim()

  if (!ca || !ca.includes('BEGIN CERTIFICATE') || !ca.includes('END CERTIFICATE')) {
    throw new Error('DATABASE_CA_CERT is missing or is not a valid PEM certificate')
  }

  return { ca, rejectUnauthorized: true }
}

export function getDb(): Pool {
  if (!pool) {
    const url = new URL(getDatabaseUrl())

    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
      url.searchParams.delete(key)
    }

    pool = new Pool({
      connectionString: url.toString(),
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      ssl: getTlsConfig(),
    })
  }

  return pool
}

export type DbClient = PoolClient
export type DbResult<T extends QueryResultRow = QueryResultRow> = QueryResult<T>
