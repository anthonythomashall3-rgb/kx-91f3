pluginManagement { repositories { google(); gradlePluginPortal(); mavenCentral() } }
dependencyResolutionManagement { repositories { google(); mavenCentral(); maven { url = uri("https://plugins.gradle.org/m2/") } } }
rootProject.name = "LOCKqz"
include(":app")
