const { createPersist } = require('stx')
const { PersistRocksDB } = require('stx-persist-rocksdb')

const {
  createUser,
  switchBranch
} = require('./auth')

createPersist(
  {
    user: {},
    route: '',
    draft: {},
    published: {}
  },
  new PersistRocksDB('db/master')
)
  .then(master => {
    const {
      createDraft,
      publishDraft
    } = require('./story')(master)

    master.branch.newBranchMiddleware = newBranch => {
      newBranch.get('user').on('create', createUser)
      newBranch.get('draft').on('create', createDraft)
      newBranch.get('draft').on('publish', publishDraft)
      newBranch.branch.clientCanUpdate = [
        {
          path: ['route']
        },
        {
          path: [ 'draft', '*', 'content' ]
        }
      ]
    }

    const server = master.listen(7071)
    server.switchBranch = switchBranch
  })
