import React, { useState } from 'react';
import { Card, SectionHeader, EmptyState, Badge, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';
import { cx, formatDateTime } from '../../lib/format';
import type { TrashItem } from './activityTypes';

interface ActivityRecycleBinProps {
  items: TrashItem[];
  total: number;
  loading: boolean;
  busy: boolean;
  selectedType: string;
  onTypeChange: (type: string) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
  onRestore: (item: TrashItem) => void;
  onPermanentDelete: (item: TrashItem) => void;
  onBulkRestore: (items: TrashItem[]) => void;
  onBulkPermanentDelete: (items: TrashItem[]) => void;
  isSuperAdmin: boolean;
}

export function ActivityRecycleBin({
  items,
  total,
  loading,
  busy,
  selectedType,
  onTypeChange,
  search,
  onSearchChange,
  onRefresh,
  onRestore,
  onPermanentDelete,
  onBulkRestore,
  onBulkPermanentDelete,
  isSuperAdmin,
}: ActivityRecycleBinProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filteredItems = items.filter((item) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      item.title.toLowerCase().includes(term) ||
      item.employeeName.toLowerCase().includes(term) ||
      item.employeeCode.toLowerCase().includes(term) ||
      item.detail.toLowerCase().includes(term) ||
      (item.deleteReason ?? '').toLowerCase().includes(term)
    );
  });

  const getItemKey = (item: TrashItem) => `${item.type}-${item.id}`;

  const toggleSelect = (item: TrashItem) => {
    const key = getItemKey(item);
    setSelectedIds((prev) => (prev.includes(key) ? prev.filter((id) => id !== key) : [...prev, key]));
  };

  const allSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.includes(getItemKey(item)));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredItems.map(getItemKey));
    }
  };

  const selectedTrashItems = items.filter((item) => selectedIds.includes(getItemKey(item)));

  const handleBulkRestoreClick = () => {
    if (selectedTrashItems.length === 0) return;
    onBulkRestore(selectedTrashItems);
    setSelectedIds([]);
  };

  const handleBulkPermanentClick = () => {
    if (selectedTrashItems.length === 0) return;
    onBulkPermanentDelete(selectedTrashItems);
    setSelectedIds([]);
  };

  return (
    <div className="space-y-5">
      {/* Policy Notice Card */}
      <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4 text-xs text-sky-900 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon name="shield" size={18} className="text-sky-700 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold uppercase tracking-wider text-[11px] text-sky-800">
              Activity Data Protection & Audit Governance
            </p>
            <p className="mt-0.5 text-sky-800 leading-relaxed">
              Deleted activity records are safely held in this Recycle Bin and can be restored at any time. Security logs, login history, and raw forensic audit trails cannot be deleted.
            </p>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className="rounded-md bg-white px-2.5 py-1 font-mono font-bold text-sky-800 border border-sky-200 shadow-2xs">
            {total} Deleted Records
          </span>
        </div>
      </div>

      {/* Toolbar: Filters & Bulk Actions */}
      <Card className="card-pad border-ink-200/90 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Type filters */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-500 mr-1">Record Type:</span>
            {[
              { key: 'all', label: 'All Records' },
              { key: 'app', label: 'Application Usage' },
              { key: 'browser', label: 'Browser Activity' },
              { key: 'module', label: 'Platform Module' },
              { key: 'session', label: 'Work Sessions' },
              { key: 'summary', label: 'Daily Summaries' },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onTypeChange(t.key)}
                className={cx(
                  'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
                  selectedType === t.key
                    ? 'bg-brand-700 text-white shadow-xs'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Search & Refresh */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px]">
              <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="text"
                placeholder="Search deleted records…"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                className="input py-1.5 pl-8 text-xs w-full"
              />
            </div>
            <button
              type="button"
              className="btn-secondary btn-sm h-8 px-2.5 text-xs"
              onClick={onRefresh}
              disabled={loading || busy}
              title="Refresh Recycle Bin"
            >
              <Icon name="refresh" size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Bulk action banner when items are selected */}
        {selectedIds.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50/70 p-2.5 text-xs text-brand-900">
            <span className="font-semibold">
              {selectedIds.length} item{selectedIds.length > 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary btn-sm h-7 px-3 text-xs font-semibold inline-flex items-center gap-1.5"
                disabled={busy}
                onClick={handleBulkRestoreClick}
              >
                <Icon name="undo" size={13} />
                <span>Restore Selected</span>
              </button>

              {isSuperAdmin && (
                <button
                  type="button"
                  className="btn-danger btn-sm h-7 px-3 text-xs font-semibold inline-flex items-center gap-1.5"
                  disabled={busy}
                  onClick={handleBulkPermanentClick}
                >
                  <Icon name="trash" size={13} />
                  <span>Permanently Purge Selected</span>
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Recycle Bin Table */}
      <Card className="border-ink-200/90 shadow-sm">
        <div className="card-pad pb-0 flex items-center justify-between">
          <SectionHeader
            title="Recycle Bin Items"
            description="Soft-deleted activity logs. Restoring returns them to the active timeline; permanent purge is restricted to Super Admin."
          />
        </div>

        {loading && !items.length ? (
          <div className="p-6">
            <Skeleton lines={8} />
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-6">
            <EmptyState
              compact
              title="Recycle Bin is empty"
              description="No soft-deleted activity records match your selected filter."
            />
          </div>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                      title="Select all"
                    />
                  </th>
                  <th>Record Type</th>
                  <th>Employee</th>
                  <th>Activity Item & Details</th>
                  <th>Active Duration</th>
                  <th>Deleted At</th>
                  <th>Deleted By</th>
                  <th>Deletion Reason</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const isSelected = selectedIds.includes(getItemKey(item));
                  return (
                    <tr key={getItemKey(item)} className={isSelected ? 'bg-brand-50/30' : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(item)}
                          className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                        />
                      </td>
                      <td>
                        <Badge
                          tone={
                            item.type === 'app'
                              ? 'brand'
                              : item.type === 'browser'
                              ? 'info'
                              : item.type === 'module'
                              ? 'neutral'
                              : item.type === 'session'
                              ? 'success'
                              : 'warning'
                          }
                        >
                          {item.typeLabel}
                        </Badge>
                      </td>
                      <td>
                        <div>
                          <p className="font-semibold text-ink-900 text-xs sm:text-sm">{item.employeeName}</p>
                          <p className="text-[11px] font-mono text-ink-500">{item.employeeCode}</p>
                        </div>
                      </td>
                      <td>
                        <div>
                          <p className="font-medium text-ink-800 text-xs sm:text-sm">{item.title}</p>
                          {item.detail && <p className="text-xs text-ink-500">{item.detail}</p>}
                          {item.recordedAt && (
                            <p className="text-[10px] text-ink-400 font-mono">
                              Recorded: {formatDateTime(item.recordedAt)}
                            </p>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="text-xs font-mono font-medium text-ink-700">
                          {item.durationMinutes ? `${item.durationMinutes}m` : '—'}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs font-mono text-ink-700">
                          {formatDateTime(item.deletedAt)}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs font-medium text-ink-800">
                          {item.deletedBy?.name ?? 'Administrator'}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs text-ink-600 italic">
                          {item.deleteReason || 'No reason provided'}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            className="btn-secondary btn-sm h-7 px-2.5 text-xs font-semibold inline-flex items-center gap-1 text-emerald-700 hover:bg-emerald-50"
                            onClick={() => onRestore(item)}
                            disabled={busy}
                            title="Restore to active timeline"
                          >
                            <Icon name="undo" size={12} />
                            <span>Restore</span>
                          </button>

                          {isSuperAdmin && (
                            <button
                              type="button"
                              className="btn-ghost btn-sm h-7 px-2 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                              onClick={() => onPermanentDelete(item)}
                              disabled={busy}
                              title="Permanently purge (cannot be undone)"
                            >
                              <Icon name="trash" size={12} />
                              <span>Purge</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
