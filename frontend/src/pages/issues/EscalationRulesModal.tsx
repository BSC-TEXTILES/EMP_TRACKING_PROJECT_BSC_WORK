import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import { Modal } from '../../components/ui';
import type { EscalationRuleItem } from '../../lib/types';

interface EscalationRulesModalProps {
  open: boolean;
  onClose: () => void;
}

export function EscalationRulesModal({ open, onClose }: EscalationRulesModalProps) {
  const toast = useToast();
  const [rules, setRules] = useState<EscalationRuleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      api.get<{ rules: EscalationRuleItem[] }>('/issues/rules')
        .then((res) => setRules(res.rules ?? []))
        .catch((err) => toast.error(errorMessage(err)))
        .finally(() => setLoading(false));
    }
  }, [open]);

  const updateField = (index: number, field: keyof EscalationRuleItem, value: any) => {
    setRules((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/issues/rules', {
        rules: rules.map((r) => ({
          priority: r.priority,
          ack_reminder_minutes: Number(r.ack_reminder_minutes),
          escalate_after_minutes: Number(r.escalate_after_minutes),
          resolve_within_hours: Number(r.resolve_within_hours),
          overdue_repeat_minutes: Number(r.overdue_repeat_minutes),
          max_level: Number(r.max_level),
          notify_higher_immediately: Boolean(r.notify_higher_immediately),
        })),
      });
      toast.success('Escalation SLA rules updated successfully.');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Issue Escalation & SLA Rules Configuration">
      {loading ? (
        <div className="py-12 text-center text-sm text-ink-500">Loading rules…</div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <p className="text-xs text-ink-600 leading-relaxed">
            Configure automatic acknowledgement reminders, SLA breach auto-escalations, and resolution deadlines per priority.
            Changes apply to all stores immediately.
          </p>

          <div className="space-y-3">
            {rules.map((rule, idx) => (
              <div key={rule.id} className="rounded-xl border border-ink-200 bg-white p-3.5 space-y-3">
                <div className="flex items-center justify-between border-b border-ink-100 pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-ink-900">
                    {rule.priority} Priority SLA
                  </span>
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(rule.notify_higher_immediately)}
                      onChange={(e) => updateField(idx, 'notify_higher_immediately', e.target.checked ? 1 : 0)}
                      className="rounded text-brand-600 focus:ring-brand-500"
                    />
                    <span>Notify higher authority immediately upon creation</span>
                  </label>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <label className="text-ink-500 block mb-1">Ack Reminder (Mins)</label>
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      className="input py-1 text-xs"
                      value={rule.ack_reminder_minutes}
                      onChange={(e) => updateField(idx, 'ack_reminder_minutes', e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <label className="text-ink-500 block mb-1">Auto-Escalate (Mins)</label>
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      className="input py-1 text-xs"
                      value={rule.escalate_after_minutes}
                      onChange={(e) => updateField(idx, 'escalate_after_minutes', e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <label className="text-ink-500 block mb-1">Resolution SLA (Hours)</label>
                    <input
                      type="number"
                      min={1}
                      max={720}
                      className="input py-1 text-xs"
                      value={rule.resolve_within_hours}
                      onChange={(e) => updateField(idx, 'resolve_within_hours', e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <label className="text-ink-500 block mb-1">Max Level</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      className="input py-1 text-xs"
                      value={rule.max_level}
                      onChange={(e) => updateField(idx, 'max_level', e.target.value)}
                      required
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
            <button type="button" onClick={onClose} className="btn-secondary btn-sm" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary btn-sm" disabled={saving}>
              {saving ? 'Saving Rules…' : 'Save Escalation Rules'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
