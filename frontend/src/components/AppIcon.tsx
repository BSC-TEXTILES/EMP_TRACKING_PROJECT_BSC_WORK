import React from 'react';

interface AppIconProps {
  name?: string | null;
  className?: string;
  size?: number;
}

export function AppIcon({ name, className = '', size = 20 }: AppIconProps) {
  const norm = (name ?? '').toLowerCase();

  // Visual Studio Code
  if (norm.includes('visual studio code') || norm.includes('code') || norm.includes('vscode')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Visual Studio Code">
        <path d="M18.5 2.5l-8.7 8.1-4.2-3.2-3.1 1.5 5.5 4.6-5.5 4.6 3.1 1.5 4.2-3.2 8.7 8.1 4.5-2.2V4.7l-4.5-2.2z" fill="#0066B8" />
        <path d="M18.5 2.5l-8.7 8.1 2.2 1.9 6.5-5.3V2.5z" fill="#007ACC" />
        <path d="M18.5 21.5l-8.7-8.1 2.2-1.9 6.5 5.3v4.7z" fill="#1F8AD2" />
        <path d="M2.5 8.9v6.2l3.8-3.1-3.8-3.1z" fill="#0065A9" />
      </svg>
    );
  }

  // Google Chrome
  if (norm.includes('chrome')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Google Chrome">
        <circle cx="12" cy="12" r="10" fill="#EA4335" />
        <circle cx="12" cy="12" r="4.5" fill="#FFFFFF" />
        <circle cx="12" cy="12" r="3.2" fill="#1A73E8" />
        <path d="M12 7.5h8.5A10 10 0 0 0 7 3.3L11 10.2A4.5 4.5 0 0 1 12 7.5z" fill="#EA4335" />
        <path d="M12 16.5l-4.2 7.3A10 10 0 0 0 21.6 15h-8A4.5 4.5 0 0 1 12 16.5z" fill="#FBBC05" />
        <path d="M7.5 12a4.5 4.5 0 0 1 .6-2.2L3.9 2.5A10 10 0 0 0 2.4 17l5.7-3a4.5 4.5 0 0 1-.6-2z" fill="#34A853" />
      </svg>
    );
  }

  // Microsoft Edge
  if (norm.includes('edge') || norm.includes('msedge')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft Edge">
        <circle cx="12" cy="12" r="10" fill="#0078D7" />
        <path d="M12 2a10 10 0 0 1 10 10c0 4.5-3 8.3-7.2 9.5-3.8 1.1-7-1.4-7-5.5 0-3.3 2.7-6 6-6h3.2c-.8-3.5-3.9-6-7.5-6-4.4 0-8 3.6-8 8 0 1.2.3 2.4.8 3.5-1.4-2-2.3-4.4-2.3-7 0-5.5 4.5-10 10-10z" fill="#00BCF2" />
        <path d="M12 10a6 6 0 0 0-6 6c0 3.3 2.7 6 6 6 2.2 0 4.2-1.2 5.2-3H13.8c-2.1 0-3.8-1.7-3.8-3.8 0-1.8 1.3-3.4 3.1-3.7L12 10z" fill="#00D26A" />
      </svg>
    );
  }

  // Microsoft Excel
  if (norm.includes('excel')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft Excel">
        <rect x="5" y="3" width="16" height="18" rx="2" fill="#107C41" />
        <path d="M10 8h9v2h-9zm0 3h9v2h-9zm0 3h9v2h-9z" fill="#33C481" opacity="0.4" />
        <rect x="2" y="6" width="11" height="12" rx="1.5" fill="#185C37" />
        <path d="M5.5 9.5l2 2.5-2 2.5h1.5l1.2-1.7 1.2 1.7h1.5l-2-2.5 2-2.5h-1.5l-1.2 1.7-1.2-1.7h-1.5z" fill="#FFFFFF" />
      </svg>
    );
  }

  // Microsoft Word
  if (norm.includes('word') || norm.includes('winword')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft Word">
        <rect x="5" y="3" width="16" height="18" rx="2" fill="#185ABD" />
        <path d="M10 8h9v2h-9zm0 3h9v2h-9zm0 3h9v2h-9z" fill="#4B89DC" opacity="0.4" />
        <rect x="2" y="6" width="11" height="12" rx="1.5" fill="#103F91" />
        <path d="M4.5 9.5l1.3 5h1.2l1-3.5 1 3.5h1.2l1.3-5h-1.3l-.7 3.5-.9-3.5h-1.2l-.9 3.5-.7-3.5h-1.3z" fill="#FFFFFF" />
      </svg>
    );
  }

  // Microsoft PowerPoint
  if (norm.includes('powerpoint') || norm.includes('powerpnt')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft PowerPoint">
        <rect x="5" y="3" width="16" height="18" rx="2" fill="#D24726" />
        <rect x="2" y="6" width="11" height="12" rx="1.5" fill="#B73A1E" />
        <path d="M6 9.5h2.5c1.1 0 1.9.8 1.9 1.8s-.8 1.8-1.9 1.8H7.3v1.9H6V9.5zm1.3 2.4h1.1c.4 0 .7-.3.7-.6s-.3-.6-.7-.6H7.3v1.2z" fill="#FFFFFF" />
      </svg>
    );
  }

  // Microsoft Teams
  if (norm.includes('teams')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft Teams">
        <rect x="3" y="4" width="18" height="16" rx="3" fill="#5059C9" />
        <circle cx="16" cy="8.5" r="2" fill="#7B83EB" />
        <path d="M13.5 12.5h5c.8 0 1.5.7 1.5 1.5v1h-8v-1c0-.8.7-1.5 1.5-1.5z" fill="#7B83EB" />
        <circle cx="10" cy="9.5" r="2.5" fill="#FFFFFF" />
        <path d="M6.5 14h7c.8 0 1.5.7 1.5 1.5V17H5v-1.5c0-.8.7-1.5 1.5-1.5z" fill="#FFFFFF" />
        <rect x="2" y="6" width="9" height="11" rx="1.5" fill="#444BB9" />
        <path d="M4.5 8.5h4v1.2h-1.3v4.3h-1.4V9.7H4.5V8.5z" fill="#FFFFFF" />
      </svg>
    );
  }

  // Microsoft Outlook
  if (norm.includes('outlook')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Microsoft Outlook">
        <rect x="5" y="4" width="16" height="16" rx="2" fill="#0072C6" />
        <path d="M10 9l5.5 3.5L21 9v8a1 1 0 0 1-1 1h-10V9z" fill="#004D8C" opacity="0.6" />
        <rect x="2" y="6" width="11" height="12" rx="1.5" fill="#005A9E" />
        <ellipse cx="7.5" cy="12" rx="2.5" ry="3.5" fill="none" stroke="#FFFFFF" strokeWidth="1.4" />
      </svg>
    );
  }

  // File Explorer / Windows Explorer
  if (norm.includes('explorer') || norm.includes('folder') || norm.includes('directory')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="File Explorer">
        <path d="M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H3V5z" fill="#F8A51D" />
        <path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" fill="#FFC83D" />
        <path d="M2 10.5h20v8.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8.5z" fill="#FFE27A" opacity="0.6" />
      </svg>
    );
  }

  // Slack
  if (norm.includes('slack')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Slack">
        <circle cx="12" cy="12" r="10" fill="#4A154B" />
        <path d="M8.5 11a1.5 1.5 0 0 1 1.5-1.5h1.5v3H10a1.5 1.5 0 0 1-1.5-1.5z" fill="#E01E5A" />
        <path d="M13 11h3a1.5 1.5 0 0 1 0 3h-3v-3z" fill="#2EB67D" />
        <path d="M11 8.5a1.5 1.5 0 0 1 3 0V10h-3V8.5z" fill="#36C5F0" />
        <path d="M11 14h3v1.5a1.5 1.5 0 0 1-3 0V14z" fill="#ECB22E" />
      </svg>
    );
  }

  // Zoom
  if (norm.includes('zoom')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Zoom">
        <circle cx="12" cy="12" r="10" fill="#2D8CFF" />
        <rect x="5.5" y="8" width="8" height="8" rx="1.5" fill="#FFFFFF" />
        <polygon points="14.5,10 18.5,8 18.5,16 14.5,14" fill="#FFFFFF" />
      </svg>
    );
  }

  // WhatsApp
  if (norm.includes('whatsapp')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="WhatsApp">
        <circle cx="12" cy="12" r="10" fill="#25D366" />
        <path d="M16.5 14.2c-.2-.1-1.3-.6-1.5-.7-.2-.1-.4-.1-.5.1-.2.2-.6.7-.7.8-.1.1-.3.1-.5 0-.2-.1-.9-.3-1.7-1-.6-.5-1-1.2-1.1-1.4-.1-.2 0-.3.1-.4.1-.1.2-.2.3-.4.1-.1.1-.2.2-.3 0-.1 0-.3-.1-.4-.1-.1-.5-1.2-.7-1.6-.2-.4-.4-.3-.5-.3h-.4c-.1 0-.4.1-.6.3-.2.2-.8.8-.8 2 0 1.2.9 2.3 1 2.5.1.1 1.7 2.6 4.1 3.7.6.3 1 .4 1.4.5.6.2 1.1.2 1.5.1.5-.1 1.4-.6 1.6-1.1.2-.5.2-1 .1-1.1-.1-.1-.3-.2-.5-.3z" fill="#FFFFFF" />
      </svg>
    );
  }

  // Terminal / PowerShell / Command Prompt
  if (norm.includes('terminal') || norm.includes('powershell') || norm.includes('cmd')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Terminal">
        <rect x="3" y="4" width="18" height="16" rx="2" fill="#1E1E1E" />
        <path d="M7 8l4 4-4 4" stroke="#4EC9B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <line x1="13" y1="16" x2="17" y2="16" stroke="#CE9178" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  // Notepad / Text Editor
  if (norm.includes('notepad')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Notepad">
        <rect x="4" y="3" width="16" height="18" rx="2" fill="#E6EEF8" stroke="#3A6073" strokeWidth="1.2" />
        <line x1="7" y1="7" x2="17" y2="7" stroke="#3A6073" strokeWidth="1.2" />
        <line x1="7" y1="11" x2="17" y2="11" stroke="#3A6073" strokeWidth="1.2" />
        <line x1="7" y1="15" x2="13" y2="15" stroke="#3A6073" strokeWidth="1.2" />
        <polygon points="15,14 18,17 19.5,15.5 16.5,12.5" fill="#F39C12" />
      </svg>
    );
  }

  // Figma
  if (norm.includes('figma')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Figma">
        <circle cx="12" cy="12" r="10" fill="#222" />
        <circle cx="14.5" cy="12" r="2.5" fill="#1ABCFE" />
        <path d="M9.5 7h5a2.5 2.5 0 0 1 0 5h-5V7z" fill="#FF7262" />
        <path d="M9.5 7h-2.5a2.5 2.5 0 0 0 0 5h2.5V7z" fill="#F24E1E" />
        <path d="M9.5 12h-2.5a2.5 2.5 0 0 0 0 5h2.5v-5z" fill="#A259FF" />
        <circle cx="9.5" cy="19.5" r="2.5" fill="#0ACF83" />
      </svg>
    );
  }

  // Postman
  if (norm.includes('postman')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label="Postman">
        <circle cx="12" cy="12" r="10" fill="#FF6C37" />
        <circle cx="12" cy="12" r="7" fill="#FFFFFF" opacity="0.2" />
        <polygon points="9,7 17,12 9,17" fill="#FFFFFF" />
      </svg>
    );
  }

  // Generic fallback application window
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 text-brand-600 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label={name ?? 'Application'}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <circle cx="6" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
