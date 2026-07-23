import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

/**
 * Pairing / onboarding shell.
 * Full form + WS auth.pair lands in Task 9.
 */
export function PairScreen() {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <LinearGradient
        colors={[theme.colors.gradientStart, theme.colors.gradientMid, theme.colors.gradientEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <Text style={styles.badge}>Mobile Claude</Text>
        <Text style={styles.title}>连接 Agent 守护进程</Text>
        <Text style={styles.subtitle}>
          在电脑上启动 agent，输入主机、端口与配对码，即可在手机上安全遥控编码会话。
        </Text>
      </LinearGradient>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>配对表单</Text>
        <Text style={styles.cardBody}>
          主机 / 端口 / 配对码 / 设备名称将在下一任务接入。当前为导航与主题壳层。
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  hero: {
    paddingTop: theme.spacing.xxl + theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    borderBottomLeftRadius: theme.radius.xl,
    borderBottomRightRadius: theme.radius.xl,
  },
  badge: {
    alignSelf: 'flex-start',
    color: theme.colors.textInverse,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
    fontSize: theme.fontSize.xs,
    fontWeight: '600',
    marginBottom: theme.spacing.md,
  },
  title: {
    color: theme.colors.textInverse,
    fontSize: theme.fontSize.xxl,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  card: {
    margin: theme.spacing.lg,
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.soft,
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    marginBottom: theme.spacing.sm,
  },
  cardBody: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
});
