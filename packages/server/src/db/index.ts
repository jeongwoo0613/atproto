import {
  Badge,
  Follow,
  Like,
  LikedByView,
  Post,
  Profile,
  Repost,
} from '@adxp/microblog'
import { DataSource } from 'typeorm'
import { DbPlugin, ViewFn } from './types'
import postPlugin, { PostIndex } from './records/post'
import likePlugin, { LikeIndex } from './records/like'
import followPlugin, { FollowIndex } from './records/follow'
import badgePlugin, { BadgeIndex } from './records/badge'
import profilePlugin, { ProfileIndex } from './records/profile'
import repostPlugin, { RepostIndex } from './records/repost'
import likedByView from './views/likedBy'
import userFollowsView from './views/userFollows'
import userFollowersView from './views/userFollows'
import { AdxUri } from '@adxp/common'
import { CID } from 'multiformats/cid'
import { RepoRoot } from './repo-root'
import { AdxRecord } from './record'
import { UserDid } from './user-dids'

export class Database {
  db: DataSource
  records: {
    posts: DbPlugin<Post.Record, PostIndex>
    likes: DbPlugin<Like.Record, LikeIndex>
    follows: DbPlugin<Follow.Record, FollowIndex>
    badges: DbPlugin<Badge.Record, BadgeIndex>
    profiles: DbPlugin<Profile.Record, ProfileIndex>
    reposts: DbPlugin<Repost.Record, RepostIndex>
  }
  views: Record<string, ViewFn>

  constructor(db: DataSource) {
    this.db = db
    this.records = {
      posts: postPlugin(db),
      likes: likePlugin(db),
      follows: followPlugin(db),
      badges: badgePlugin(db),
      profiles: profilePlugin(db),
      reposts: repostPlugin(db),
    }
    this.views = {}
    this.views['blueskyweb.xyz:LikedByView'] = likedByView(db)
    this.views['blueskyweb.xyz:UserFollowsView'] = userFollowsView(db)
    this.views['blueskyweb.xyz:UserFollowersView'] = userFollowersView(db)
    this.db.synchronize()
  }

  static async sqlite(location: string): Promise<Database> {
    const db = new DataSource({
      type: 'sqlite',
      database: location,
      entities: [
        RepoRoot,
        AdxRecord,
        PostIndex,
        LikeIndex,
        FollowIndex,
        BadgeIndex,
        ProfileIndex,
        RepostIndex,
        UserDid,
      ],
    })
    await db.initialize()
    return new Database(db)
  }

  static async memory(): Promise<Database> {
    return Database.sqlite(':memory:')
  }

  async getRepoRoot(did: string): Promise<CID | null> {
    const table = this.db.getRepository(RepoRoot)
    const found = await table.findOneBy({ did })
    if (found === null) return null
    return CID.parse(found.root)
  }

  async setRepoRoot(did: string, root: CID) {
    const table = this.db.getRepository(RepoRoot)
    let newRoot = await table.findOneBy({ did })
    if (newRoot === null) {
      newRoot = new RepoRoot()
      newRoot.did = did
    }
    newRoot.root = root.toString()
    await table.save(newRoot)
  }

  async getDidForUsername(username: string): Promise<string | null> {
    const table = this.db.getRepository(UserDid)
    const found = await table.findOneBy({ username })
    return found ? found.did : null
  }

  async getUsernameForDid(did: string): Promise<string | null> {
    const table = this.db.getRepository(UserDid)
    const found = await table.findOneBy({ did })
    return found ? found.username : null
  }

  async registerUser(username: string, did: string) {
    const table = this.db.getRepository(UserDid)
    const user = new UserDid()
    user.username = username
    user.displayName = username
    user.did = did
    await table.save(user)
  }

  async indexRecord(uri: AdxUri, obj: unknown) {
    const record = new AdxRecord()
    record.uri = uri.toString()

    record.did = uri.host
    if (!record.did.startsWith('did:')) {
      throw new Error('Expected indexed URI to contain DID')
    }
    record.collection = uri.collection
    if (record.collection.length < 1) {
      throw new Error('Expected indexed URI to contain a collection')
    }
    record.tid = uri.recordKey
    if (record.tid.length < 1) {
      throw new Error('Expected indexed URI to contain a record TID')
    }

    const table = this.findTableForCollection(uri.collection)
    await table.set(uri, obj)
    const recordTable = this.db.getRepository(AdxRecord)
    await recordTable.save(record)
  }

  async deleteRecord(uri: AdxUri) {
    const table = this.findTableForCollection(uri.collection)
    const recordTable = this.db.getRepository(AdxRecord)
    await Promise.all([table.delete(uri), recordTable.delete(uri)])
  }

  async listCollectionsForDid(did: string): Promise<string[]> {
    const recordTable = await this.db
      .getRepository(AdxRecord)
      .createQueryBuilder('record')
      .select('record.collection')
      .where('record.did = :did', { did })
      .getRawMany()

    return recordTable
  }

  async listRecordsForCollection(
    did: string,
    collection: string,
    limit: number,
    before?: string, // 14 z's is larger than any TID
  ): Promise<unknown[]> {
    const builder = await this.db
      .createQueryBuilder()
      .select('record.uri')
      .from(AdxRecord, 'record')
      .where('record.did = :did', { did })
      .andWhere('record.collection = :collection', { collection })
      .orderBy('record.tid', 'DESC')
      .limit(limit)

    if (before !== undefined) {
      builder.andWhere('record.tid <= :before', { before })
    }
    const res = await builder.getRawMany()

    const uris: string[] = res.map((row) => row.record_uri)

    const table = this.findTableForCollection(collection)
    return table.getMany(uris)
  }

  async getRecord(uri: AdxUri): Promise<unknown | null> {
    const table = this.findTableForCollection(uri.collection)
    return table.get(uri)
  }

  findTableForCollection(collection: string) {
    const found = Object.values(this.records).find(
      (plugin) => plugin.collection === collection,
    )
    if (!found) {
      throw new Error('Could not find table for collection')
    }
    return found
  }
}

export default Database
