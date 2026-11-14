/** Only replay a whole rolled-back transaction. Never retry ambiguous commits. */
export async function retryDeadlock<T>(work: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if ((error as { code?: string }).code !== 'ER_LOCK_DEADLOCK' || attempt >= retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 25)));
    }
  }
}
