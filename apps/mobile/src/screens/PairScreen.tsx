import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useConnection } from '../state/connection';
import { theme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Pair'>;

/**
 * Pairing form: host / port / pairing code / device name → auth.pair → Main.
 */
export function PairScreen({ navigation }: Props) {
  const { pair } = useConnection();
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('7820');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('我的手机');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const portNum = Number.parseInt(port.trim(), 10);
      if (!Number.isInteger(portNum)) {
        throw new Error('端口必须是数字');
      }
      await pair({
        host: host.trim(),
        port: portNum,
        code: code.trim(),
        deviceName: deviceName.trim(),
      });
      navigation.reset({
        index: 0,
        routes: [{ name: 'Main' }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          <LinearGradient
            colors={[
              theme.colors.gradientStart,
              theme.colors.gradientMid,
              theme.colors.gradientEnd,
            ]}
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
            <Text style={styles.cardTitle}>配对</Text>

            <Field label="主机">
              <TextInput
                style={styles.input}
                value={host}
                onChangeText={setHost}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="127.0.0.1 或局域网 IP"
                placeholderTextColor={theme.colors.textMuted}
                editable={!submitting}
              />
            </Field>

            <Field label="端口">
              <TextInput
                style={styles.input}
                value={port}
                onChangeText={setPort}
                keyboardType="number-pad"
                placeholder="7820"
                placeholderTextColor={theme.colors.textMuted}
                editable={!submitting}
              />
            </Field>

            <Field label="配对码">
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="终端显示的配对码"
                placeholderTextColor={theme.colors.textMuted}
                editable={!submitting}
              />
            </Field>

            <Field label="设备名称">
              <TextInput
                style={styles.input}
                value={deviceName}
                onChangeText={setDeviceName}
                placeholder="例如：我的手机"
                placeholderTextColor={theme.colors.textMuted}
                editable={!submitting}
              />
            </Field>

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                submitting && styles.buttonDisabled,
              ]}
              onPress={() => {
                void onSubmit();
              }}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={theme.colors.textInverse} />
              ) : (
                <Text style={styles.buttonText}>连接并配对</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingBottom: theme.spacing.xxl,
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
    marginBottom: theme.spacing.md,
  },
  field: {
    marginBottom: theme.spacing.md,
  },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceMuted,
  },
  errorBox: {
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm + 2,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  button: {
    backgroundColor: theme.colors.primaryDark,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonPressed: {
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: theme.colors.textInverse,
    fontSize: theme.fontSize.md,
    fontWeight: '700',
  },
});
