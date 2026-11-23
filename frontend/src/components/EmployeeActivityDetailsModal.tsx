import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  employeeId: number | null;
  initialDate?: string;
}

/**
 * Employee activity details now live on a full page backed by the tracking
 * engine (/activity-tracking/:id). Existing callers (Employees, Profile,
 * Activity) keep using this component and are sent to that page, so every
 * entry point shows the same observed data.
 */
export function EmployeeActivityDetailsModal({ open, onClose, employeeId, initialDate }: Props) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!open || !employeeId) return;
    navigate(`/activity-tracking/${employeeId}${initialDate ? `?date=${encodeURIComponent(initialDate)}` : ''}`);
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId]);
  return null;
}
