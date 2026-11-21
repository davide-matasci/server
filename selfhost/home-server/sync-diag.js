// Read-only check of how this home server would page a full download of each
// account (a new device's first sync), to find what can stall it. Prints only
// counts, sizes and timestamps, never note content. Run from the data directory:
//
//   linux --root /data/alpine sh -c 'cd /var/lib/sn && \
//     node --require /opt/sn/.pnp.cjs /opt/sn/sync-diag.js'
const APP = process.env.SN_APP || '/opt/sn'
const requireFromServer = require('module').createRequire(`${APP}/packages/syncing-server/package.json`)
const sqlite3 = requireFromServer('sqlite3')

const PageSize = 150
const TransferLimit = Number(process.env.CONTENT_SIZE_TRANSFER_LIMIT || 10000000)
const dbPath = process.argv[2] || `${process.cwd()}/home_server.sqlite`

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY)
const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))

;(async () => {
  const users = await all('select user_uuid, count(*) as n from items where deleted = 0 group by user_uuid')
  for (const { user_uuid: user, n } of users) {
    console.log(`\naccount ${user.slice(0, 8)}…: ${n} items`)

    const sharedTimestamps = await all(
      `select updated_at_timestamp as t, count(*) as n from items where user_uuid = ? and deleted = 0
       group by updated_at_timestamp having count(*) > 1 order by n desc limit 5`,
      [user],
    )
    const worst = sharedTimestamps[0]
    console.log(
      worst
        ? `  most items sharing one updated_at timestamp: ${worst.n} (${new Date(worst.t / 1000).toISOString()})` +
            (worst.n >= PageSize ? `  <-- ${PageSize}+ share it: paging can't get past them` : '')
        : '  every item has its own updated_at timestamp',
    )

    const items = await all(
      `select updated_at_timestamp as t, content_type as type, content_size as declared, length(content) as actual from items
       where user_uuid = ? and deleted = 0 order by updated_at_timestamp asc`,
      [user],
    )
    let page = 0
    for (let start = 0; start < items.length; page++) {
      let bytes = 0
      let end = start
      while (end < items.length && end - start < PageSize) {
        bytes += items[end].declared ?? 0
        end++
        if (bytes >= TransferLimit && end - start > 1) {
          break
        }
      }
      const slice = items.slice(start, end)
      const actual = slice.reduce((sum, item) => sum + (item.actual ?? 0), 0)
      const largestItem = slice.reduce((max, item) => ((item.actual ?? 0) > (max.actual ?? 0) ? item : max))
      const largest = largestItem.actual ?? 0
      const flags = []
      if (actual > 5000000) flags.push('large page')
      if (slice.some((item) => item.declared == null)) flags.push('items without content_size')
      if (page < 3 || flags.length) {
        console.log(
          `  page ${page + 1}: items ${start + 1}-${end}, ${(actual / 1e6).toFixed(2)} MB, largest item ${(largest / 1e6).toFixed(2)} MB (${largestItem.type})` +
            (flags.length ? `  <-- ${flags.join(', ')}` : ''),
        )
      }
      start = end
    }
    console.log(`  ${page} pages in total`)
  }
  db.close()
})().catch((error) => {
  console.error(`sync-diag: ${error.message}`)
  process.exit(1)
})
