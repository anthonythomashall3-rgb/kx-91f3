plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
// Version = app/VERSION (one number for every platform).
val lqVersion = rootProject.file("../VERSION").readText().trim()
android {
    namespace = "app.lockqz"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.lockqz"
        minSdk = 26
        targetSdk = 33
        versionCode = lqVersion.split(".").map { it.toInt() }.let { it[0] * 10000 + it[1] * 100 + it[2] }
        versionName = lqVersion
    }
    // One signing key for every build, so an installed app updates in place (Android refuses an update signed
    // with another key). The key is never in the repo: CI writes it from the GitHub secret ANDROID_KEYSTORE_B64
    // (+ ANDROID_KEYSTORE_PASS) to the path in LOCKQZ_KEYSTORE. Without it (a laptop build, or the secret not set
    // yet) the build falls back to Android's debug key - installable, but a later build with the real key needs
    // an uninstall first.
    val ksPath = System.getenv("LOCKQZ_KEYSTORE"); val ksPass = System.getenv("LOCKQZ_KEYSTORE_PASS") ?: ""
    val haveKey = ksPath != null && file(ksPath).isFile
    signingConfigs {
        create("lockqz") {
            if (haveKey) { storeFile = file(ksPath!!); storePassword = ksPass; keyAlias = "lockqz"; keyPassword = ksPass }
            else { storeFile = signingConfigs.getByName("debug").storeFile; storePassword = "android"; keyAlias = "androiddebugkey"; keyPassword = "android" }
        }
    }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("lockqz") }
        debug { signingConfig = signingConfigs.getByName("lockqz") }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { abortOnError = false }
}
dependencies {
    testImplementation("junit:junit:4.13.2")
}
