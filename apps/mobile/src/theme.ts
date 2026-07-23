/**
 * Purple / indigo SaaS design tokens for Mobile Claude.
 * Prefer these over ad-hoc hex values in screens/components.
 */
export const theme = {
  colors: {
    /** Primary brand (indigo) */
    primary: '#6366F1',
    primaryDark: '#4F46E5',
    primaryLight: '#818CF8',
    /** Secondary brand (purple) */
    purple: '#8B5CF6',
    purpleDark: '#7C3AED',
    purpleLight: '#A78BFA',
    /** Gradients */
    gradientStart: '#7C3AED',
    gradientMid: '#6366F1',
    gradientEnd: '#4F46E5',
    /** Surfaces */
    background: '#F8FAFC',
    surface: '#FFFFFF',
    surfaceMuted: '#F1F5F9',
    /** Text */
    text: '#0F172A',
    textSecondary: '#64748B',
    textInverse: '#FFFFFF',
    textMuted: '#94A3B8',
    /** Borders & states */
    border: '#E2E8F0',
    borderFocus: '#818CF8',
    danger: '#EF4444',
    dangerSoft: '#FEE2E2',
    success: '#22C55E',
    successSoft: '#DCFCE7',
    warning: '#F59E0B',
    warningSoft: '#FEF3C7',
    overlay: 'rgba(15, 23, 42, 0.45)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    full: 9999,
  },
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 22,
    xxl: 28,
  },
  shadow: {
    soft: {
      shadowColor: '#4F46E5',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 12,
      elevation: 4,
    },
  },
} as const;

export type Theme = typeof theme;
