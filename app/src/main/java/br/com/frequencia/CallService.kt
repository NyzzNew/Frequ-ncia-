package br.com.frequencia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class CallService : Service() {
    companion object {
        internal const val END = "br.com.frequencia.END_CALL"
        internal const val FAILED = "br.com.frequencia.CALL_SERVICE_FAILED"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == END) {
            sendBroadcast(Intent(END).setPackage(packageName))
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val type = (if (intent.getBooleanExtra("mic", false)) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or
            (if (intent.getBooleanExtra("camera", false)) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel("calls", "Chamadas do Frequência", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE)
        val end = PendingIntent.getService(this, 2, Intent(this, CallService::class.java).setAction(END), PendingIntent.FLAG_IMMUTABLE)
        val notice = Notification.Builder(this, "calls").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Chamada em andamento").setContentText("Frequência")
            .setOngoing(true).setContentIntent(open).addAction(Notification.Action.Builder(null, "Sair da chamada", end).build()).build()
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(750, notice, type)
            else startForeground(750, notice)
        } catch (_: RuntimeException) {
            sendBroadcast(Intent(FAILED).setPackage(packageName))
            stopSelf()
        }
        return START_NOT_STICKY
    }
}
