import {
  type CoreDatabase,
  withImmediateTransaction,
} from "./database.js";

export class AuthRepository {
  constructor(private readonly database: CoreDatabase) {}

  immediate<T>(work: () => T): T {
    return withImmediateTransaction(this.database, work);
  }
}
