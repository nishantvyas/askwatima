cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
set(EXTRA_COMPONENT_DIRS components/externlib)

# The OTA client compares esp_app_desc_t.version to decide whether an update
# applies. The IDF default is "1" for every build, which would make every image
# look identical and no device would ever update - so this must be set.
#
# The VERSION file is the source of truth (works outside a git checkout, and is
# what a release actually bumps); a git describe is appended when available so
# a dev build is distinguishable from the tagged one it came from.
# esp_app_desc_t.version is 32 bytes - keep it short.
file(READ ${CMAKE_CURRENT_LIST_DIR}/VERSION WATIMA_VERSION)
string(STRIP "${WATIMA_VERSION}" WATIMA_VERSION)

# Without this, CMake reads VERSION once at configure time and a later edit is
# ignored - so bumping the version would silently rebuild the SAME image, and a
# rollout would go out believing it shipped a fix it did not. Make the file a
# configure dependency so touching it forces a reconfigure.
set_property(DIRECTORY APPEND PROPERTY
             CMAKE_CONFIGURE_DEPENDS ${CMAKE_CURRENT_LIST_DIR}/VERSION)

execute_process(
    COMMAND git describe --always --dirty
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE GIT_DESC
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(GIT_DESC)
    set(PROJECT_VER "${WATIMA_VERSION}+${GIT_DESC}")
else()
    set(PROJECT_VER "${WATIMA_VERSION}")
endif()
message(STATUS "Watima firmware version: ${PROJECT_VER}")

project(watima)
