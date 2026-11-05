package br.com.frequencia

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.ScreenSharePresets
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

internal class VoicePanel(
    private val activity: ComponentActivity,
    root: FrameLayout,
    private val api: Api,
    private val changed: (JSONObject) -> Unit,
) {
    private val foreground = Color.rgb(242, 239, 230)
    private val muted = Color.rgb(176, 178, 169)
    private val lime = Color.rgb(212, 243, 106)
    private val base = Color.rgb(23, 24, 25)
    private val slab = Color.rgb(42, 44, 43)
    private val panel = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(10), dp(16), dp(14))
        setBackgroundColor(base)
        isClickable = true
        visibility = View.GONE
    }
    private val title = label("", 22, foreground, true)
    private val status = label("", 13, lime)
    private val participants = label("", 15, foreground)
    private val videoArea = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val micButton = button("Ligar microfone") { requestTrack(false) }
    private val cameraButton = button("Ligar câmera") { requestTrack(true) }
    private val screenButton = button("Compartilhar tela") { requestScreen() }
    private var channel = ""
    private var name = ""
    private var connected = false
    private var reconnecting = false
    private var room: Room? = null
    private var connectionJob: Job? = null
    private var eventsJob: Job? = null
    private var controlJob: Job? = null
    private var permissionRoom: Room? = null
    private var captureRoom: Room? = null
    private var cameraRequested = false
    private var microphone = false
    private var camera = false
    private var screen = false
    private var fullHd = false
    private var wantsForeground = false

    private data class Tile(val track: VideoTrack, val view: TextureViewRenderer, val container: LinearLayout)
    private val tiles = linkedMapOf<String, Tile>()

    private val notificationPermission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val mediaPermission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        val expected = permissionRoom
        permissionRoom = null
        if (expected != null && expected === room) {
            if (allowed) toggleTrack(cameraRequested)
            else toast(if (cameraRequested) "Permita a câmera nas configurações do Android." else "Permita o microfone nas configurações do Android.")
        }
    }
    private val projection = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val expected = captureRoom
        captureRoom = null
        val data = result.data
        if (expected != null && expected === room && result.resultCode == Activity.RESULT_OK && data != null) {
            control {
                val published = expected.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, onStop = {
                    activity.runOnUiThread {
                        if (expected === room) {
                            screen = false
                            render()
                        }
                    }
                }))
                if (published) screen = true else toast("Não foi possível compartilhar a tela.")
            }
        }
    }
    private val serviceEvents = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == CallService.FAILED && wantsForeground) {
                toast("O Android interrompeu o acesso à câmera ou ao microfone.")
                leave()
            } else if (intent?.action == CallService.END) leave()
        }
    }

    val visible: Boolean get() = panel.visibility == View.VISIBLE

    init {
        ContextCompat.registerReceiver(activity, serviceEvents, IntentFilter().apply {
            addAction(CallService.END)
            addAction(CallService.FAILED)
        }, ContextCompat.RECEIVER_NOT_EXPORTED)
        panel.addView(row(button("‹  Voltar ao chat") { minimize() }, button("Sair", danger = true) { leave() }))
        panel.addView(title, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
        panel.addView(status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(12) })
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(videoArea)
            addView(participants, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
        }
        panel.addView(ScrollView(activity).apply { addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        panel.addView(row(micButton, cameraButton))
        panel.addView(screenButton, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        root.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }

    fun join(id: String, label: String, hd: Boolean) {
        if (!Regex("[a-f0-9-]{36}").matches(id)) throw AppError(400, "Canal de voz inválido.")
        if (channel == id) {
            show()
            return
        }
        if (channel.isNotEmpty()) throw AppError(409, "Saia da chamada atual antes de entrar em outra.")
        val session = api.connection()
        if (session.token.isBlank()) throw AppError(401, "Entre na sua conta.")
        channel = id
        name = label
        fullHd = hd
        show()
        connectionJob = activity.lifecycleScope.launch {
            try {
                val access = withContext(Dispatchers.IO) { api.request("POST", "/api/channels/$id/call", connection = session) }
                val url = Api.validatedOrigin(access.getString("url"), call = true)
                val share = if (fullHd) ScreenSharePresets.H1080_FPS30 else ScreenSharePresets.H720_FPS15
                val instance = LiveKit.create(activity.applicationContext, RoomOptions(
                    adaptiveStream = true,
                    dynacast = true,
                    screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true,
                        captureParams = share.capture.copy(adaptOutputToDimensions = false)),
                    screenShareTrackPublishDefaults = VideoTrackPublishDefaults(videoEncoding = share.encoding),
                ))
                room = instance
                eventsJob = activity.lifecycleScope.launch {
                    instance.events.collect { event ->
                        if (room !== instance) return@collect
                        when (event) {
                            is RoomEvent.Disconnected -> {
                                toast("A chamada foi desconectada.")
                                leave()
                            }
                            is RoomEvent.Reconnecting -> { reconnecting = true; render() }
                            is RoomEvent.Reconnected -> { reconnecting = false; render() }
                            is RoomEvent.TrackSubscribed, is RoomEvent.TrackUnsubscribed,
                            is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished,
                            is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted,
                            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected,
                            is RoomEvent.ActiveSpeakersChanged -> render()
                            else -> Unit
                        }
                    }
                }
                withTimeout(25_000) { instance.connect(url, access.getString("token")) }
                connected = true
                render()
                if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
                    val preferences = activity.getSharedPreferences("call-permissions", Context.MODE_PRIVATE)
                    if (!preferences.getBoolean("asked_notifications", false)) {
                        preferences.edit().putBoolean("asked_notifications", true).apply()
                        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException && error !is kotlinx.coroutines.TimeoutCancellationException) throw error
                toast((error as? AppError)?.message ?: "Falha ao conectar à chamada. Confira a rede e o servidor de voz.")
                leave()
            }
        }
    }

    private fun requestTrack(video: Boolean) {
        val instance = room ?: return
        if (permissionRoom != null || captureRoom != null || controlJob?.isActive == true || !connected || reconnecting) return
        val permission = if (video) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO
        if (!granted(permission)) {
            permissionRoom = instance
            cameraRequested = video
            mediaPermission.launch(permission)
        } else toggleTrack(video)
    }

    private fun toggleTrack(video: Boolean) = control {
        val instance = room ?: return@control
        val enable = if (video) !camera else !microphone
        if (enable) syncForeground(microphone || !video, camera || video)
        try {
            val success = if (video) instance.localParticipant.setCameraEnabled(enable)
                else instance.localParticipant.setMicrophoneEnabled(enable)
            if (success) {
                if (video) camera = enable else microphone = enable
            } else toast(if (video) "Câmera indisponível." else "Microfone indisponível.")
        } finally {
            if (instance === room) syncForeground(microphone, camera)
        }
    }

    private fun requestScreen() {
        val instance = room ?: return
        if (permissionRoom != null || captureRoom != null || controlJob?.isActive == true || !connected || reconnecting) return
        if (screen) control {
            if (instance.localParticipant.setScreenShareEnabled(false)) screen = false
        } else {
            val manager = activity.getSystemService(MediaProjectionManager::class.java)
            captureRoom = instance
            try { projection.launch(manager.createScreenCaptureIntent()) } catch (_: RuntimeException) {
                captureRoom = null
                toast("A captura de tela está indisponível.")
            }
        }
    }

    private fun control(action: suspend () -> Unit) {
        if (controlJob?.isActive == true) return
        controlJob = activity.lifecycleScope.launch {
            try {
                action()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                toast("O Android não conseguiu iniciar ou alterar a mídia.")
            } finally { render() }
        }
    }

    private fun syncForeground(mic: Boolean, video: Boolean) {
        wantsForeground = mic || video
        val service = Intent(activity, CallService::class.java).putExtra("mic", mic).putExtra("camera", video)
        if (wantsForeground) ContextCompat.startForegroundService(activity, service)
        else activity.stopService(service)
    }

    fun show() {
        if (channel.isBlank()) return
        activity.currentFocus?.let { activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0) }
        panel.visibility = View.VISIBLE
        render()
    }

    fun minimize() {
        panel.visibility = View.GONE
        clearTiles()
        render()
    }

    fun leave() {
        val instance = room
        room = null
        connectionJob?.cancel()
        eventsJob?.cancel()
        controlJob?.cancel()
        connectionJob = null
        eventsJob = null
        controlJob = null
        permissionRoom = null
        captureRoom = null
        channel = ""
        name = ""
        connected = false
        reconnecting = false
        microphone = false
        camera = false
        screen = false
        panel.visibility = View.GONE
        clearTiles()
        runCatching { instance?.disconnect() }
        runCatching { instance?.release() }
        syncForeground(false, false)
        render()
    }

    fun destroy() {
        leave()
        activity.unregisterReceiver(serviceEvents)
    }

    private fun render() {
        val instance = room
        val people = if (connected && instance != null) listOf(instance.localParticipant) + instance.remoteParticipants.values else emptyList()
        val ready = connected && !reconnecting
        title.text = name
        status.text = when {
            reconnecting -> "RECONECTANDO"
            connected -> "${people.size} NA CHAMADA"
            else -> "CONECTANDO"
        }
        participants.text = people.joinToString("\n\n") {
            val nickname = it.name ?: "Participante"
            val activity = if (it.isSpeaking) "   ·   falando" else if (!it.isMicrophoneEnabled) "   ·   mudo" else ""
            "●  " + nickname + (if (it == instance?.localParticipant) " (você)" else "") + activity
        }
        micButton.text = if (microphone) "Silenciar" else "Ligar microfone"
        cameraButton.text = if (camera) "Desligar câmera" else "Ligar câmera"
        screenButton.text = if (screen) "Parar de compartilhar" else "Compartilhar tela · " + if (fullHd) "1080p" else "720p"
        listOf(micButton, cameraButton, screenButton).forEach { it.isEnabled = ready }
        if (visible && instance != null) {
            val tracks = people.flatMap { participant ->
                participant.trackPublications.values.mapNotNull { publication ->
                    val track = publication.track as? VideoTrack
                    if (publication.muted || track == null ||
                        (participant == instance.localParticipant && publication.source == Track.Source.SCREEN_SHARE)) null
                    else Triple(publication, track, participant.name ?: "Participante")
                }
            }
            val incoming = tracks.associateBy { it.first.sid }
            for ((id, tile) in tiles.toMap()) {
                if (incoming[id]?.second !== tile.track) {
                    releaseTile(tile)
                    tiles.remove(id)
                }
            }
            for ((pub, track, user) in tracks.sortedBy { it.first.source != Track.Source.SCREEN_SHARE }) {
                if (pub.sid in tiles) continue
                val renderer = TextureViewRenderer(activity).apply {
                    instance.initVideoRenderer(this)
                    setScalingType(livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                }
                val caption = if (pub.source == Track.Source.SCREEN_SHARE) "$user • tela" else "$user • câmera"
                val tile = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    background = surface(slab)
                    addView(renderer, LinearLayout.LayoutParams(-1, dp(200)))
                    addView(label(caption, 13, this@VoicePanel.foreground).apply { setPadding(dp(12), dp(8), dp(12), dp(8)) })
                }
                track.addRenderer(renderer)
                tiles[pub.sid] = Tile(track, renderer, tile)
                videoArea.addView(tile, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
            }
        }
        changed(JSONObject().put("channel", channel).put("name", name).put("count", people.size)
            .put("connected", connected).put("reconnecting", reconnecting).put("screen", screen))
    }

    private fun releaseTile(tile: Tile) {
        tile.track.removeRenderer(tile.view)
        tile.view.release()
        videoArea.removeView(tile.container)
    }

    private fun clearTiles() {
        tiles.values.forEach(::releaseTile)
        tiles.clear()
    }

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(text: String) { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
    private fun surface(color: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(10).toFloat() }
    private fun label(text: String, size: Int, color: Int = muted, bold: Boolean = false) = TextView(activity).apply {
        this.text = text
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        gravity = Gravity.START
    }
    private fun button(text: String, danger: Boolean = false, action: () -> Unit) = Button(activity).apply {
        this.text = text
        isAllCaps = false
        textSize = 14f
        minHeight = dp(48)
        minimumHeight = dp(48)
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
            intArrayOf(muted, if (danger) Color.rgb(255, 177, 170) else this@VoicePanel.foreground)))
        background = surface(if (danger) Color.rgb(71, 35, 35) else slab)
        setOnClickListener { action() }
    }
    private fun row(first: Button, second: Button) = LinearLayout(activity).apply {
        addView(first, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(6) })
        addView(second, LinearLayout.LayoutParams(0, -2, 1f))
    }
}
