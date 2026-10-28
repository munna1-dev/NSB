import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

let pool: Pool | undefined

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured')
  }

  return databaseUrl
}

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      ssl: {
        rejectUnauthorized: true,
      },
    })
  }

  return pool
}

export type DbClient = PoolClient
export type DbResult<T extends QueryResultRow = QueryResultRow> = QueryResult<T>
