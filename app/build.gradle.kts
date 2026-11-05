plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "1.9.25"
}

android {
    namespace = "br.com.frequencia"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "br.com.frequencia"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    buildTypes {
        getByName("release") {
            if (System.getenv("FREQUENCIA_KEYSTORE") != null) {
                signingConfig = signingConfigs.create("distribution") {
                    storeFile = file(System.getenv("FREQUENCIA_KEYSTORE"))
                    storePassword = System.getenv("FREQUENCIA_STORE_PASSWORD")
                    keyAlias = System.getenv("FREQUENCIA_KEY_ALIAS")
                    keyPassword = System.getenv("FREQUENCIA_KEY_PASSWORD")
                }
            }
        }
    }
}

dependencies {
    implementation("io.livekit:livekit-android:2.22.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
