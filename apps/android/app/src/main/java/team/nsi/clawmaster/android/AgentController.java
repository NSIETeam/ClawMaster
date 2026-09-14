package team.nsi.clawmaster.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import team.nsi.clawmaster.core.AgentEngine;
import team.nsi.clawmaster.core.ChatClient;
import team.nsi.clawmaster.core.ConversationStore;
import team.nsi.clawmaster.core.NoteStore;

/** Single active foreground turn with one-shot, Activity-independent approvals. */
final class AgentController {
    interface Listener { void changed(); }
    final SecureSettings settings;
    final NoteStore notes;
    final ConversationStore conversations;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<Listener> listeners = new ArrayList<>();
    private JSONObject current;
    private volatile JSONObject snapshot;
    private volatile boolean running;
    private volatile String status = "";
    private volatile JSONObject approval;
    private CompletableFuture<Boolean> approvalResult;
    private AgentEngine.Cancellation cancellation;
    private AgentEngine.Model model;

    AgentController(Context context) throws Exception {
        settings = new SecureSettings(context);
        notes = new NoteStore(context.getFilesDir().toPath().resolve("notes"));
        conversations = new ConversationStore(context.getFilesDir().toPath().resolve("conversations"));
        List<JSONObject> history = conversations.list();
        current = history.isEmpty() ? conversations.create() : conversations.load(history.get(0).getString("id"));
        snapshot = new JSONObject(current.toString());
        if (current.optBoolean("interrupted")) status = "interrupted";
    }
    void observe(Listener listener) { listeners.add(listener); listener.changed(); }
    void remove(Listener listener) { listeners.remove(listener); }
    JSONObject snapshot() { return snapshot; }
    JSONObject approval() { return approval; }
    boolean running() { return running; }
    String status() { return status; }

    private void notifyListeners() {
        main.post(() -> { for (Listener listener : new ArrayList<>(listeners)) listener.changed(); });
    }
    private void publish(JSONObject record, String state) throws Exception {
        snapshot = new JSONObject(record.toString());
        status = state;
        notifyListeners();
    }

    void newConversation() throws Exception {
        if (running) throw new IllegalStateException("busy");
        current = conversations.create();
        publish(current, "");
    }
    void open(String id) throws Exception {
        if (running) throw new IllegalStateException("busy");
        current = conversations.load(id);
        publish(current, current.optBoolean("interrupted") ? "interrupted" : "");
    }
    void send(String text) throws Exception {
        send(text, new ChatClient(settings.base(), settings.model(), settings.key()));
    }

    /** Package-private provider injection is used only by on-device instrumentation. */
    void send(String text, AgentEngine.Model provider) {
        if (running) throw new IllegalStateException("busy");
        running = true;
        status = "thinking";
        model = provider;
        cancellation = new AgentEngine.Cancellation();
        notifyListeners();
        JSONObject record = current;
        AgentEngine.Cancellation token = cancellation;
        worker.execute(() -> {
            String finalState = "complete";
            try {
                new AgentEngine(provider, notes, conversations).run(record, text, new AgentEngine.Observer() {
                    @Override public void changed(JSONObject value, String operation) throws Exception { publish(value, operation); }
                    @Override public boolean approve(JSONObject proposal, AgentEngine.Cancellation cancelled) throws Exception {
                        CompletableFuture<Boolean> result = new CompletableFuture<>();
                        synchronized (AgentController.this) {
                            cancelled.check();
                            approvalResult = result;
                            approval = proposal;
                            status = "approval";
                        }
                        notifyListeners();
                        try { return result.get(); }
                        finally {
                            synchronized (AgentController.this) {
                                approval = null;
                                approvalResult = null;
                            }
                            notifyListeners();
                        }
                    }
                }, token);
            } catch (CancellationException stopped) {
                finalState = "stopped";
            } catch (Exception failure) {
                finalState = AgentEngine.safeError(failure);
            } finally {
                String completion = finalState;
                main.post(() -> {
                    running = false;
                    try { publish(record, completion); }
                    catch (Exception failure) { status = "storage_error"; notifyListeners(); }
                });
            }
        });
    }
    synchronized void decide(JSONObject displayed, boolean allowed) {
        if (approval == displayed && approvalResult != null) approvalResult.complete(allowed);
    }
    synchronized void stop() {
        if (!running) return;
        cancellation.cancel();
        if (model != null) model.cancel();
        if (approvalResult != null) approvalResult.complete(false);
    }
}
