const { createPersist } = require('stx')
const { PersistRocksDB } = require('stx-persist-rocksdb')
const { generateId } = require('./utils')
const crypto = require('crypto')

let auth

createPersist({}, new PersistRocksDB('db/auth'))
  .then(authState => {
    auth = authState
  })

const setErrorStatus = (user, error) => {
  if (user.get('type') !== undefined) {
    user.set({ status: 'error', error })
  }
}

const createUser = (master, user, _, branchUser) => {
  branchUser.set({ status: 'createStarted', error: null })

  try {
    user = JSON.parse(user)
  } catch (e) {
    return setErrorStatus(branchUser, 'Malformed user JSON')
  }

  const { name, email, password } = user

  if (!new RegExp('^[^@]+@[^@.]+(\\.[^@.]+)*$').test(email)) {
    return setErrorStatus(branchUser, 'Invalid e-mail')
  }

  if (auth.get(email) !== undefined) {
    return setErrorStatus(branchUser, 'User exists')
  }

  const id = generateId()

  const salt = crypto.randomBytes(64)
  const hash = crypto.scryptSync(password, salt, 64).toString('base64')

  auth.set({
    [email]: {
      salt: salt.toString('base64'),
      hash,
      id
    }
  })
  master.get('author').set({
    [id]: { name, published: {} }
  })
  branchUser.set({ status: 'created' })
}

const loadUser = async (switcher, email, token, user) => {
  const userBranch = await switcher(
    email, new PersistRocksDB(`db/user/${email}`)
  )

  if (userBranch.get(['user', 'type']) === undefined) {
    userBranch.get('user').set({
      type: 'real',
      author: ['@', 'author', user.get('id').compute()],
      email,
      token,
      tokenExpiresAt: user.get('tokenExpiresAt').compute()
    })
    userBranch.set({ route: '/me' })
  } else {
    userBranch.get('user').set({
      token,
      tokenExpiresAt: user.get('tokenExpiresAt').compute()
    })
  }

  return true
}

const authByPassword = async (email, password, switcher) => {
  const user = auth.get(email)
  if (user !== void 0) {
    const salt = Buffer.from(user.get('salt').compute(), 'base64')
    const hash = crypto.scryptSync(password, salt, 64).toString('base64')
    if (user.get('hash').compute() === hash) {
      const tokenExpiresAt = user.get('tokenExpiresAt')
      let token
      if (
        tokenExpiresAt !== void 0 &&
        tokenExpiresAt.compute() > Date.now()
      ) {
        token = user.get('token').compute()
      } else {
        token = crypto.randomBytes(64).toString('base64')
        user.set({
          token,
          tokenExpiresAt: Date.now() + 86400 * 1000 * 10
        })
      }
      return loadUser(switcher, email, token, user)
    }
  }
}

const authByToken = async (email, token, switcher) => {
  const user = auth.get(email)
  if (user !== void 0) {
    const tokenExpiresAt = user.get('tokenExpiresAt')
    if (
      tokenExpiresAt !== void 0 &&
      tokenExpiresAt.compute() > Date.now() &&
      user.get('token').compute() === token
    ) {
      return loadUser(switcher, email, token, user)
    }
  }
}

const switchBranch = async (fromBranch, branchKey, switcher) => {
  let authRequest
  const branchUser = fromBranch.get('user')
  branchUser.set({ status: 'loginStarted', error: null })
  try {
    authRequest = JSON.parse(branchKey)
  } catch (e) {
    return setErrorStatus(branchUser, 'Malformed authentication request')
  }
  if (!authRequest.type) {
    setErrorStatus(branchUser, 'Missing authentication type')
  } else if (
    authRequest.type === 'anonymous' &&
    authRequest.id
  ) {
    const toBranch = await switcher(authRequest.id)
    toBranch.get('user').set({
      type: 'anonymous',
      id: authRequest.id
    })
  } else if (
    authRequest.type === 'token' &&
    authRequest.email &&
    authRequest.token
  ) {
    const success = await authByToken(authRequest.email, authRequest.token, switcher)
    return success || setErrorStatus(branchUser, 'Authentication failed')
  } else if (
    authRequest.type === 'password' &&
    authRequest.email &&
    authRequest.password
  ) {
    const success = await authByPassword(authRequest.email, authRequest.password, switcher)
    return success || setErrorStatus(branchUser, 'Authentication failed')
  } else {
    setErrorStatus(branchUser, 'Unknown authentication type')
  }
}

module.exports = master => ({
  createUser: createUser.bind(null, master),
  switchBranch
})
