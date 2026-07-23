import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation';
import { theme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Sessions'>;

/**
 * Session list shell. Data + FAB wired in Task 9.
 */
export function SessionsScreen({ navigation }: Props) {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>会话</Text>
      <Text style={styles.body}>
        会话列表、下拉刷新与新建会话将在配对成功后加载。可先浏览其它页面壳层。
      </Text>
      <View style={styles.links}>
        <Text style={styles.link} onPress={() => navigation.navigate('Chat')}>
          打开对话（壳层）
        </Text>
        <Text style={styles.link} onPress={() => navigation.navigate('Files')}>
          打开文件（壳层）
        </Text>
        <Text style={styles.link} onPress={() => navigation.navigate('Settings')}>
          打开设置（壳层）
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  body: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  links: {
    gap: theme.spacing.md,
  },
  link: {
    color: theme.colors.primaryDark,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
});
