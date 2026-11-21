import { beforeAll, afterAll, it, expect } from 'vitest';
import { queryOne, execute, closePool } from '../src/db/index.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { TaskService } from '../src/services/TaskService.js';
let admin: AuthUser, a: AuthUser, b: AuthUser;
beforeAll(async () => {
 const owner = await queryOne<{id:number}>("SELECT e.id FROM employees e JOIN roles r ON r.id=e.role_id WHERE r.slug='super_admin' LIMIT 1");
 admin = (await AuthService.buildUser(owner!.id))!;
 const role = await queryOne<{id:number}>("SELECT id FROM roles WHERE slug='employee'");
 const tag = Date.now();
 const users: AuthUser[] = [];
 for (const suffix of ['a','b']) {
  const result = await execute("INSERT INTO employees (employee_code,full_name,email,mobile,password_hash,role_id,location_id,manager_id,status) VALUES (?,?,?,?,?,?,?,?,'active')", [`QA-${tag}-${suffix}`, `Task QA ${suffix}`, `task-${tag}-${suffix}@example.test`, `99${String(tag).slice(-7)}${suffix==='a'?'1':'2'}`, 'not-a-login-hash', role!.id, admin.locationId, admin.id]);
  users.push((await AuthService.buildUser(result.insertId))!);
 }
 [a,b] = users;
});
afterAll(closePool);
it('persists assignment, isolates employees, saves status and completion history', async () => {
 const created = await TaskService.create({title:'Integration task',assigneeIds:[a.id], timeSlot:'morning'},admin,{});
 expect((await TaskService.list(a,{view:'mine'})).items.some(t=>t.id===created.id)).toBe(true);
 expect((await TaskService.list(b,{view:'mine'})).items.some(t=>t.id===created.id)).toBe(false);
 await expect(TaskService.detail(created.id,b)).rejects.toMatchObject({status:404});
 await TaskService.applyAction(created.id,'accept',a,{},{});
 await TaskService.applyAction(created.id,'start',a,{},{});
 await expect(TaskService.applyAction(created.id,'hold',a,{},{})).rejects.toMatchObject({status:400});
 await TaskService.applyAction(created.id,'hold',a,{note:'Awaiting materials'},{});
 await TaskService.applyAction(created.id,'resume',a,{},{});
 await TaskService.applyAction(created.id,'submit',a,{completionNote:'Completed the assigned inspection'},{});
 await TaskService.applyAction(created.id,'approve',admin,{},{});
 expect((await TaskService.detail(created.id,a)).status).toBe('completed');
 const saved = await queryOne<{completion_note:string}>('SELECT completion_note FROM task_assignments WHERE task_id=? AND employee_id=?',[created.id,a.id]);
 expect(saved!.completion_note).toContain('inspection');
});
