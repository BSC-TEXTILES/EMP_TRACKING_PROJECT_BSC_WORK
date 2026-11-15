/** Only replay a whole rolled-back transaction. Never retry ambiguous commits. */
export async function retryDeadlock(work, retries = 2) {
    for (let attempt = 0;; attempt++) {
        try {
            return await work();
        }
        catch (error) {
            if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= retries)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 25)));
        }
    }
}
//# sourceMappingURL=deadlockRetry.js.map