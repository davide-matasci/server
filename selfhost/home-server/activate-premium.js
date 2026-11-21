// Marks an account on this home server as subscribed, with the server's own
// activation code (the step the desktop app's built-in home server runs when
// an offline subscription code is entered). Run from the data directory, so
// the server's .env is used, while the server and Redis are running:
//
//   linux --root /data/alpine sh -c 'cd /var/lib/sn && \
//     node --require /opt/sn/.pnp.cjs /opt/sn/activate-premium.js you@example.com'
//   linux --root /data/alpine sh /opt/sn/start.sh restart
//
// It starts a second copy of the server on a random local port to reach the
// activation code, activates, and exits. Restart the main server afterwards
// so it does not keep cached account data.
const APP = process.env.SN_APP || '/opt/sn'
const { HomeServer } = require(`${APP}/packages/home-server/dist/src/Server/HomeServer`)
const { Env } = require(`${APP}/packages/home-server/dist/src/Bootstrap/Env`)

const email = process.argv[2]
if (!email) {
  console.error('usage: activate-premium.js EMAIL')
  process.exit(2)
}

const env = new Env()
env.load()
const settings = env.getAll()
if (!settings || !settings.DB_SQLITE_DATABASE_PATH) {
  console.error('activate-premium: run it from the directory with the server .env (cd /var/lib/sn)')
  process.exit(2)
}

;(async () => {
  const server = new HomeServer()
  const started = await server.start({
    dataDirectoryPath: process.cwd(),
    environment: { ...settings, PORT: '0', LOG_LEVEL: 'error' },
  })
  if (started.isFailed()) {
    throw new Error(started.getError())
  }

  const result = await server.activatePremiumFeatures({
    username: email,
    subscriptionId: 1,
    subscriptionPlanName: 'PRO_PLAN',
    uploadBytesLimit: -1,
    endsAt: new Date('2099-12-31T00:00:00Z'),
    cancelPreviousSubscription: true,
  })
  if (result.isFailed()) {
    throw new Error(result.getError())
  }

  console.log(`${result.getValue()} for ${email} (Pro, until 2099). Now run: start.sh restart`)
  process.exit(0)
})().catch((error) => {
  console.error(`activate-premium: ${error.message}`)
  process.exit(1)
})
