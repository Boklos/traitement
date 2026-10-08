import { useEffect, useState, useCallback, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Réglages ──────────────────────────────────────────────
const FIRST_REMINDER = { hour: 8, minute: 0 };
const LAST_FOLLOW_UP_HOUR = 24; // dernière relance de la journée (24 = minuit)
// Relances toutes les heures après le premier rappel, jusqu'à LAST_FOLLOW_UP_HOUR
const FOLLOW_UPS = [];
for (let h = FIRST_REMINDER.hour + 1; h <= LAST_FOLLOW_UP_HOUR; h++) {
  FOLLOW_UPS.push({ hour: h, minute: FIRST_REMINDER.minute });
}
const DAYS_AHEAD = 14;   // rappels programmés à l'avance (reprogrammés à chaque ouverture)
const HISTORY_DAYS = 28; // jours affichés dans l'historique

const STORAGE_KEY = 'takenDates';
const CHANNEL_ID = 'rappels';
const CATEGORY_ID = 'DOSE';
const ACTION_TAKEN = 'TAKEN';

// Notifications discrètes : bannière + son, pas de plein écran
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ─── Utilitaires dates ─────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const atTime = (d, { hour, minute }) => {
  const x = new Date(d);
  x.setHours(hour, minute, 0, 0);
  return x;
};

// ─── Stockage ──────────────────────────────────────────────
async function loadTaken() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveTaken(list) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// ─── Notifications ─────────────────────────────────────────
async function setupNotifications() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Rappels traitement',
    importance: Notifications.AndroidImportance.DEFAULT,
  });

  await Notifications.setNotificationCategoryIdentifierAsync(CATEGORY_ID, [
    {
      identifier: ACTION_TAKEN,
      buttonTitle: 'Pris ✓',
      options: { opensAppToForeground: true },
    },
  ]);

  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === 'granted';
}

async function rescheduleAll(takenList) {
  await Notifications.cancelAllScheduledNotificationsAsync();

  const taken = new Set(takenList);
  const now = new Date();
  const times = [FIRST_REMINDER, ...FOLLOW_UPS];

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = addDays(now, i);
    const key = dateKey(day);
    if (taken.has(key)) continue;

    for (let j = 0; j < times.length; j++) {
      const when = atTime(day, times[j]);
      if (when <= now) continue;

      await Notifications.scheduleNotificationAsync({
        identifier: `dose-${key}-${j}`,
        content: {
          title: j === 0 ? 'Traitement du jour' : 'Pas encore validé',
          body:
            j === 0
              ? "C'est l'heure de prendre ton traitement."
              : "Tu n'as pas encore validé la prise d'aujourd'hui.",
          categoryIdentifier: CATEGORY_ID,
          data: { dateKey: key },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
          channelId: CHANNEL_ID,
        },
      });
    }
  }
}

// Évite deux reprogrammations en parallèle
let scheduleQueue = Promise.resolve();
function reschedule(list) {
  scheduleQueue = scheduleQueue.then(() => rescheduleAll(list)).catch(() => {});
  return scheduleQueue;
}

async function dismissPresentedFor(key) {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((n) => n.request.content.data?.dateKey === key)
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
  );
}

// ─── App ───────────────────────────────────────────────────
export default function App() {
  const [taken, setTaken] = useState([]);
  const [today, setToday] = useState(dateKey(new Date()));
  const [permOk, setPermOk] = useState(true);
  const [ready, setReady] = useState(false);
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef(new Set());

  const markTaken = useCallback(async (key) => {
    const current = await loadTaken();
    const next = current.includes(key) ? current : [...current, key];
    await saveTaken(next);
    setTaken(next);
    await reschedule(next);
    await dismissPresentedFor(key);
  }, []);

  // Initialisation + rafraîchissement au retour dans l'app
  useEffect(() => {
    (async () => {
      const ok = await setupNotifications();
      setPermOk(ok);
      const list = await loadTaken();
      setTaken(list);
      await reschedule(list);
      setReady(true);
    })();

    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      setToday(dateKey(new Date()));
      const list = await loadTaken();
      setTaken(list);
      reschedule(list);
    });

    return () => sub.remove();
  }, []);

  // Bouton « Pris ✓ » appuyé depuis une notification
  useEffect(() => {
    if (!ready || !lastResponse) return;

    const n = lastResponse.notification;
    const id = `${n.request.identifier}-${n.date}`;
    if (handled.current.has(id)) return;
    handled.current.add(id);

    if (lastResponse.actionIdentifier === ACTION_TAKEN) {
      const key = n.request.content.data?.dateKey;
      if (key) markTaken(key);
    }
    Notifications.clearLastNotificationResponse();
  }, [lastResponse, ready, markTaken]);

  const takenToday = taken.includes(today);
  const takenSet = new Set(taken);

  const historyDays = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    historyDays.push({ key: dateKey(d), day: d.getDate() });
  }
  const takenCount = historyDays.filter((d) => takenSet.has(d.key)).length;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Traitement</Text>

        {!permOk && (
          <View style={styles.warning}>
            <Text style={styles.warningText}>
              Les notifications sont désactivées. Active-les dans les réglages Android pour recevoir
              les rappels.
            </Text>
          </View>
        )}

        <View style={[styles.card, takenToday && styles.cardDone]}>
          {takenToday ? (
            <>
              <Text style={styles.doneIcon}>✓</Text>
              <Text style={styles.doneText}>Pris aujourd'hui</Text>
            </>
          ) : (
            <>
              <Text style={styles.pendingText}>Pas encore pris aujourd'hui</Text>
              <Pressable
                onPress={() => markTaken(today)}
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              >
                <Text style={styles.buttonText}>J'ai pris mon traitement</Text>
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.sectionTitle}>
          {HISTORY_DAYS} derniers jours · {takenCount}/{HISTORY_DAYS}
        </Text>
        <View style={styles.grid}>
          {historyDays.map((d) => {
            const isTaken = takenSet.has(d.key);
            const isToday = d.key === today;
            return (
              <View
                key={d.key}
                style={[styles.dot, isTaken && styles.dotTaken, isToday && styles.dotToday]}
              >
                <Text style={[styles.dotText, isTaken && styles.dotTextTaken]}>{d.day}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const GREEN = '#2E7D5B';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F6F7F5' },
  container: { padding: 24, paddingTop: 72 },
  title: { fontSize: 32, fontWeight: '700', color: '#1C1F1D', marginBottom: 24 },
  warning: { backgroundColor: '#FFF4E0', borderRadius: 12, padding: 14, marginBottom: 16 },
  warningText: { color: '#7A4B00', fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    marginBottom: 32,
    elevation: 2,
  },
  cardDone: { backgroundColor: '#E6F2EC' },
  doneIcon: { fontSize: 48, color: GREEN, fontWeight: '700' },
  doneText: { fontSize: 20, color: GREEN, fontWeight: '600', marginTop: 8 },
  pendingText: { fontSize: 18, color: '#444', marginBottom: 20 },
  button: {
    backgroundColor: GREEN,
    paddingVertical: 18,
    paddingHorizontal: 28,
    borderRadius: 14,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  sectionTitle: { fontSize: 15, color: '#666', marginBottom: 12, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#E4E6E3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotTaken: { backgroundColor: GREEN },
  dotToday: { borderWidth: 2, borderColor: '#1C1F1D' },
  dotText: { fontSize: 13, color: '#777' },
  dotTextTaken: { color: '#FFFFFF', fontWeight: '600' },
});
