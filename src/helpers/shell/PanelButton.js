/** @import PlayerProxy from './PlayerProxy.js' */
/** @import MediaControls from '../../extension.js' */
/** @import { SignalMap } from 'resource:///org/gnome/shell/misc/signals.js' */
/** @import { KeysOf } from '../../types/misc.js' */
/** @import { PlayerProxyProperties } from '../../types/dbus.js' */
/** @import { PanelControlIconOptions, MenuControlIconOptions } from '../../types/enums/shell_only.js' */

import GObject from "gi://GObject";
import Clutter from "gi://Clutter";
import GdkPixbuf from "gi://GdkPixbuf";
import GLib from "gi://GLib";
import Cogl from "gi://Cogl";
import Gio from "gi://Gio";
import St from "gi://St";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import ScrollingLabel from "./ScrollingLabel.js";
import MenuSlider from "./MenuSlider.js";
import { debugLog, errorLog } from "../../utils/common.js";
import { getAppByIdAndEntry, getImage } from "../../utils/shell_only.js";
import { ControlIconOptions } from "../../types/enums/shell_only.js";
import {
    LabelTypes,
    PanelElements,
    MouseActions,
    LoopStatus,
    PlaybackStatus,
    WidgetFlags,
} from "../../types/enums/common.js";

Gio._promisify(GdkPixbuf.Pixbuf, "new_from_stream_async", "new_from_stream_finish");
Gio._promisify(Gio.File.prototype, "query_info_async", "query_info_finish");

const POPUP_CONTENT_WIDTH = 300;
const POPUP_COVER_WIDTH = 250;

/**
 * @param {Clutter.Actor} parent
 * @param {string} name
 * @returns {any}
 */
function find_child_by_name(parent, name) {
    const children = parent.get_children();
    for (const child of children) {
        if (child.get_name() === name) {
            return child;
        }
    }
}

/**
 * @param {MenuControlIconOptions} options
 * @returns {number}
 */
function getMenuControlIndex(options) {
    if (options.name === ControlIconOptions.PREVIOUS.name) {
        return 0;
    }
    if (options.name === ControlIconOptions.PLAY.name) {
        return 1;
    }
    if (options.name === ControlIconOptions.NEXT.name) {
        return 2;
    }
    if (options.name === ControlIconOptions.LOOP_NONE.name) {
        return 0;
    }
    if (options.name === ControlIconOptions.SHUFFLE_ON.name) {
        return 1;
    }
    return 0;
}

/** @extends PanelMenu.Button */
class PanelButton extends PanelMenu.Button {
    /**
     * @private
     * @type {PlayerProxy}
     */
    playerProxy;
    /**
     * @private
     * @type {MediaControls}
     */
    extension;
    /**
     * @private
     * @type {Gio.Settings}
     */
    interfaceSettings;
    /**
     * @private
     * @type {number}
     */
    interfaceSettingsChangedId;

    /**
     * @private
     * @type {St.Icon}
     */
    buttonIcon;
    /**
     * @private
     * @type {InstanceType<typeof ScrollingLabel>}
     */
    buttonLabel;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    buttonControls;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    buttonBox;

    /**
     * @private
     * @type {PopupMenu.PopupBaseMenuItem}
     */
    menuBox;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuPlayers;
    /**
     * @private
     * @type {St.Icon}
     */
    menuImage;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuLabels;
    /**
     * @private
     * @type {InstanceType<typeof MenuSlider>}
     */
    menuSlider;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuControls;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuMainControls;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuSecondaryControls;

    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuPlayersTextBox;
    /**
     * @private
     * @type {St.Icon}
     */
    menuPlayersTextBoxIcon;
    /**
     * @private
     * @type {St.Label}
     */
    menuPlayersTextBoxLabel;
    /**
     * @private
     * @type {St.Icon}
     */
    menuPlayersTextBoxPin;
    /**
     * @private
     * @type {St.BoxLayout}
     */
    menuPlayerIcons;
    /**
     * @private
     * @type {boolean}
     */
    menuPlayersExpanded;

    /**
     * @private
     * @type {InstanceType<typeof ScrollingLabel>}
     */
    menuLabelTitle;
    /**
     * @private
     * @type {InstanceType<typeof ScrollingLabel>}
     */
    menuLabelSubtitle;
    /**
     * @private
     * @type {InstanceType<typeof ScrollingLabel>}
     */
    menuLabelAlbum;

    /**
     * @private
     * @type {number | null}
     */
    doubleTapSourceId;
    /**
     * @private
     * @type {Map<KeysOf<PlayerProxyProperties>, number>}
     */
    changeListenerIds;

    /**
     * @param {PlayerProxy} playerProxy
     * @param {MediaControls} extension
     */
    constructor(playerProxy, extension) {
        super(0.5, "Media Controls", false);
        this.playerProxy = playerProxy;
        this.extension = extension;
        this.interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
        this.interfaceSettingsChangedId = this.interfaceSettings.connect("changed::color-scheme", () => {
            this.syncColorSchemeStyle();
        });
        this.changeListenerIds = new Map();
        this.doubleTapSourceId = null;
        this.menuPlayersExpanded = false;
        this.updateWidgets(WidgetFlags.ALL);
        this.syncColorSchemeStyle();
        this.addProxyListeners();
        this.initActions();
        // @ts-expect-error
        this.menu.box.add_style_class_name("popup-menu-container");
        // Refresh the slider whenever the menu is opened. Clutter pauses
        // PropertyTransitions on unmapped actors, so the slider's elapsed
        // time drifts from the player's real position while the menu is
        // closed. Re-fetch the position on open and (re)start the transition.
        this.menu.connect("open-state-changed", (_, isOpen) => {
            if (isOpen && this.extension.showTrackSlider && this.menuSlider != null) {
                this.addMenuSlider().catch(errorLog);
            }
        });
        this.connect("destroy", this.onDestroy.bind(this));
    }

    /**
     * Override vfunc_event to handle button clicks before parent class
     * @param {Clutter.Event} _event
     * @returns {boolean}
     */
    vfunc_event(_event) {
        // Do not call super.vfunc_event() because it will handle the event
        // and possibly open the menu
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @public
     * @param {PlayerProxy} playerProxy
     * @returns {void}
     */
    updateProxy(playerProxy) {
        if (this.isSamePlayer(playerProxy) === false) {
            debugLog(`Updating proxy to ${playerProxy.busName}`);
            this.removeProxyListeners();
            this.playerProxy = playerProxy;
            this.updateWidgets(WidgetFlags.ALL);
            this.addProxyListeners();
        }
    }

    /**
     * @public
     * @param {PlayerProxy} playerProxy
     * @returns {boolean}
     */
    isSamePlayer(playerProxy) {
        return this.playerProxy.busName === playerProxy.busName;
    }

    /**
     * @public
     * @param {WidgetFlags} flags
     * @returns {void}
     */
    updateWidgets(flags) {
        if (this.buttonBox == null) {
            this.buttonBox = new St.BoxLayout({
                styleClass: "panel-button-box",
            });
        } else if (flags & WidgetFlags.PANEL_NO_REPLACE) {
            this.buttonBox.remove_all_children();
        }
        if (this.menuBox == null) {
            this.menuBox = new PopupMenu.PopupBaseMenuItem({
                style_class: "no-padding popup-menu-box",
                activate: false,
            });
            this.menuBox.set_vertical(true);
            this.menuBox.remove_style_class_name("popup-menu-item");
            this.menuBox.remove_all_children();
        }
        for (let i = 0; i < this.extension.elementsOrder.length; i++) {
            const element = PanelElements[this.extension.elementsOrder[i]];
            if (
                element === PanelElements.ICON &&
                (flags & WidgetFlags.PANEL_ICON || flags & WidgetFlags.PANEL_NO_REPLACE)
            ) {
                if (this.extension.showPlayerIcon) {
                    this.addButtonIcon(i);
                } else if (this.buttonIcon != null) {
                    this.buttonBox.remove_child(this.buttonIcon);
                    this.buttonIcon.destroy();
                    this.buttonIcon = null;
                }
            }
            if (
                element === PanelElements.LABEL &&
                (flags & WidgetFlags.PANEL_LABEL || flags & WidgetFlags.PANEL_NO_REPLACE)
            ) {
                if (this.extension.showLabel) {
                    this.addButtonLabel(i);
                } else if (this.buttonLabel != null) {
                    this.buttonBox.remove_child(this.buttonLabel);
                    this.buttonLabel.destroy();
                    this.buttonLabel = null;
                }
            }
            if (
                element === PanelElements.CONTROLS &&
                (flags & WidgetFlags.PANEL_CONTROLS || flags & WidgetFlags.PANEL_NO_REPLACE)
            ) {
                if (this.extension.showControlIcons) {
                    this.addButtonControls(i, flags);
                } else if (this.buttonControls != null) {
                    this.buttonBox.remove_child(this.buttonControls);
                    this.buttonControls.destroy();
                    this.buttonControls = null;
                }
            }
        }
        if (flags & WidgetFlags.MENU_PLAYERS) {
            this.addMenuPlayers();
        }
        if (flags & WidgetFlags.MENU_IMAGE) {
            this.addMenuImage().catch(errorLog);
        }
        if (flags & WidgetFlags.MENU_LABELS) {
            this.addMenuLabels();
        }
        if (flags & WidgetFlags.MENU_SLIDER) {
            if (this.extension.showTrackSlider) {
                this.addMenuSlider().catch(errorLog);
            } else if (this.menuSlider != null) {
                this.menuBox.remove_child(this.menuSlider);
                this.menuSlider.destroy();
                this.menuSlider = null;
            }
        }
        if (flags & WidgetFlags.MENU_CONTROLS) {
            this.addMenuControls(flags);
        }
        if (this.buttonBox.get_parent() == null) {
            this.add_child(this.buttonBox);
        }
        if (this.menuBox.get_parent() == null) {
            // @ts-expect-error
            this.menu.addMenuItem(this.menuBox);
        }
    }

    /**
     * @private
     * @returns {void}
     */
    addMenuPlayers() {
        if (this.menuPlayers == null) {
            this.menuPlayers = new St.BoxLayout({
                vertical: true,
                styleClass: "popup-menu-players",
            });
        }
        if (this.menuPlayersTextBox == null) {
            this.menuPlayersTextBox = new St.BoxLayout({
                styleClass: "popup-menu-player-pill",
                xAlign: Clutter.ActorAlign.CENTER,
                reactive: true,
                trackHover: true,
            });
            if (typeof Clutter.ClickGesture !== "undefined") {
                const clickAction = new Clutter.ClickGesture();
                clickAction.set_n_clicks_required(1);
                if (clickAction.set_recognize_on_press) {
                    clickAction.set_recognize_on_press(true);
                }
                clickAction.connect("recognize", () => {
                    if (this.extension.getPlayers().length > 1) {
                        this.menuPlayersExpanded = !this.menuPlayersExpanded;
                        this.updateWidgets(WidgetFlags.MENU_PLAYERS);
                    }
                    return Clutter.EVENT_STOP;
                });
                this.menuPlayersTextBox.add_action(clickAction);
            } else {
                const clickAction = new Clutter.ClickAction();
                clickAction.connect("clicked", () => {
                    if (this.extension.getPlayers().length > 1) {
                        this.menuPlayersExpanded = !this.menuPlayersExpanded;
                        this.updateWidgets(WidgetFlags.MENU_PLAYERS);
                    }
                });
                this.menuPlayersTextBox.add_action(clickAction);
            }
        }
        const menuColoredClass = this.extension.coloredPlayerIconMenu ? "colored-icon" : "symbolic-icon";
        if (
            this.menuPlayersTextBoxIcon != null &&
            !this.menuPlayersTextBoxIcon.has_style_class_name(menuColoredClass)
        ) {
            if (this.menuPlayersTextBoxIcon.get_parent() != null) {
                this.menuPlayersTextBoxIcon.get_parent().remove_child(this.menuPlayersTextBoxIcon);
            }
            this.menuPlayersTextBoxIcon.destroy();
            this.menuPlayersTextBoxIcon = null;
        }
        if (this.menuPlayersTextBoxIcon == null) {
            this.menuPlayersTextBoxIcon = new St.Icon({
                styleClass: `popup-menu-icon popup-menu-player-pill-icon ${menuColoredClass}`,
                yAlign: Clutter.ActorAlign.CENTER,
            });
        }
        if (this.menuPlayersTextBoxLabel == null) {
            this.menuPlayersTextBoxLabel = new St.Label({
                styleClass: "popup-menu-player-label",
                yAlign: Clutter.ActorAlign.CENTER,
                xAlign: Clutter.ActorAlign.CENTER,
                xExpand: true,
            });
        }
        if (this.menuPlayersTextBoxPin == null) {
            this.menuPlayersTextBoxPin = new St.Icon({
                iconName: "view-pin-symbolic",
                styleClass: "popup-menu-icon popup-menu-player-pin",
                yAlign: Clutter.ActorAlign.CENTER,
                reactive: true,
                trackHover: true,
            });

            if (typeof Clutter.ClickGesture !== "undefined") {
                const pinClickAction = new Clutter.ClickGesture();
                pinClickAction.set_n_clicks_required(1);
                if (pinClickAction.set_recognize_on_press) {
                    pinClickAction.set_recognize_on_press(true);
                }
                pinClickAction.connect("recognize", () => {
                    if (this.playerProxy.isPlayerPinned()) {
                        this.playerProxy.unpinPlayer();
                    } else {
                        this.playerProxy.pinPlayer();
                    }
                    return Clutter.EVENT_STOP;
                });
                this.menuPlayersTextBoxPin.add_action(pinClickAction);
            } else {
                const pinClickAction = new Clutter.ClickAction();
                pinClickAction.connect("clicked", () => {
                    if (this.playerProxy.isPlayerPinned()) {
                        this.playerProxy.unpinPlayer();
                    } else {
                        this.playerProxy.pinPlayer();
                    }
                });
                this.menuPlayersTextBoxPin.add_action(pinClickAction);
            }
        }
        const players = this.extension.getPlayers();
        if (players.length <= 1) {
            this.menuPlayersExpanded = false;
        }
        if (players.length > 1 && this.menuPlayersExpanded && this.menuPlayerIcons == null) {
            this.menuPlayerIcons = new St.BoxLayout({
                vertical: true,
                styleClass: "popup-menu-player-list",
            });
        } else if ((players.length <= 1 || !this.menuPlayersExpanded) && this.menuPlayerIcons != null) {
            this.menuPlayerIcons.get_children().forEach((child) => child.destroy());
            if (this.menuPlayerIcons.get_parent() === this.menuPlayers) {
                this.menuPlayers.remove_child(this.menuPlayerIcons);
            }
            this.menuPlayerIcons.destroy();
            this.menuPlayerIcons = null;
        } else if (this.menuPlayerIcons != null) {
            this.menuPlayerIcons.get_children().forEach((child) => child.destroy());
        }
        const isPinned = this.playerProxy.isPlayerPinned();
        this.menuPlayersTextBoxPin.opacity = isPinned ? 255 : 160;
        this.menuPlayersTextBoxPin.visible = players.length > 1;
        this.menuPlayersTextBoxPin.reactive = players.length > 1;
        this.menuPlayersTextBoxPin.set_style_pseudo_class(isPinned ? "checked" : null);
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const app = getAppByIdAndEntry(player.identity, player.desktopEntry);
            const isSamePlayer = this.isSamePlayer(player);
            const appName = app?.get_name() ?? (player.identity || _("Unknown player"));
            const appIcon = app?.get_icon() ?? Gio.Icon.new_for_string("audio-x-generic-symbolic");
            if (isSamePlayer) {
                this.menuPlayersTextBoxLabel.text = appName;
                this.menuPlayersTextBoxIcon.gicon = appIcon;
            }
            if (this.menuPlayerIcons != null) {
                const button = new St.Button({
                    name: `player-${i}`,
                    styleClass: "button popup-menu-player-list-row",
                    reactive: isPinned === false,
                    trackHover: isPinned === false,
                    canFocus: isPinned === false,
                    toggleMode: true,
                    checked: isSamePlayer,
                });
                const row = new St.BoxLayout({
                    styleClass: "popup-menu-player-list-row-box",
                });
                const icon = new St.Icon({
                    styleClass: `popup-menu-icon popup-menu-player-list-icon ${menuColoredClass}`,
                    gicon: appIcon,
                    yAlign: Clutter.ActorAlign.CENTER,
                });
                const label = new St.Label({
                    text: appName,
                    yAlign: Clutter.ActorAlign.CENTER,
                    xExpand: true,
                });
                row.add_child(icon);
                row.add_child(label);
                if (isSamePlayer) {
                    row.add_child(
                        new St.Icon({
                            iconName: "object-select-symbolic",
                            styleClass: "popup-menu-icon popup-menu-player-list-check",
                            yAlign: Clutter.ActorAlign.CENTER,
                        }),
                    );
                }
                button.set_child(row);
                if (!isSamePlayer) {
                    button.connect("clicked", () => {
                        this.menuPlayersExpanded = false;
                        this.updateProxy(player);
                    });
                }
                this.menuPlayerIcons.add_child(button);
            }
        }
        for (const child of [this.menuPlayersTextBoxIcon, this.menuPlayersTextBoxLabel, this.menuPlayersTextBoxPin]) {
            const parent = child.get_parent();
            if (parent !== this.menuPlayersTextBox) {
                parent?.remove_child(child);
                this.menuPlayersTextBox.add_child(child);
            }
        }
        if (this.menuPlayersTextBox.get_parent() == null) {
            this.menuPlayers.add_child(this.menuPlayersTextBox);
        }
        if (this.menuPlayerIcons && this.menuPlayerIcons.get_parent() == null) {
            this.menuPlayers.add_child(this.menuPlayerIcons);
        }
        if (this.menuPlayers.get_parent() == null) {
            this.menuBox.add_child(this.menuPlayers);
            debugLog("Added menu players");
        }
    }

    /**
     * @private
     * @returns {Promise<void>}
     */
    async addMenuImage() {
        if (this.menuImage == null) {
            this.menuImage = new St.Icon({
                styleClass: "popup-menu-cover-art",
                xExpand: false,
                yExpand: false,
                xAlign: Clutter.ActorAlign.CENTER,
            });
        }
        let artSet = false;
        let stream = await getImage(this.playerProxy.metadata["mpris:artUrl"]);
        if (stream == null && this.playerProxy.metadata["xesam:url"] != null) {
            const trackUri = GLib.uri_parse(this.playerProxy.metadata["xesam:url"], GLib.UriFlags.NONE);
            if (trackUri != null && trackUri.get_scheme() === "file") {
                const file = Gio.File.new_for_uri(trackUri.to_string());
                const info = await file
                    .query_info_async(
                        `${Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH},${Gio.FILE_ATTRIBUTE_STANDARD_ICON}`,
                        Gio.FileQueryInfoFlags.NONE,
                        null,
                        null,
                    )
                    .catch(errorLog);
                if (info != null) {
                    const path = info.get_attribute_byte_string(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH);
                    if (path == null) {
                        this.menuImage.gicon = info.get_icon();
                    } else {
                        const thumb = Gio.File.new_for_path(path);
                        stream = await getImage(thumb.get_uri());
                    }
                }
            }
        }
        const width = this.getCoverArtWidth();
        if (stream != null) {
            /** @type {Promise<GdkPixbuf.Pixbuf>} */
            const pixbufPromise = /** @type {any} */ (GdkPixbuf.Pixbuf.new_from_stream_async(stream, null));
            const pixbuf = await pixbufPromise.catch(errorLog);
            if (pixbuf != null) {
                const aspectRatio = pixbuf.width / pixbuf.height;
                const height = width / aspectRatio;
                const radius = this.extension.coverArtRadius;
                let renderPixbuf = pixbuf;
                if (radius > 0) {
                    // Scale to display size before rounding so the radius
                    // matches the user's setting in screen pixels rather than
                    // being shrunk by the St scaling step.
                    const targetW = Math.max(1, Math.round(width));
                    const targetH = Math.max(1, Math.round(height));
                    const scaled = pixbuf.scale_simple(targetW, targetH, GdkPixbuf.InterpType.BILINEAR);
                    renderPixbuf = this.roundPixbufCorners(scaled ?? pixbuf, radius);
                }
                const [success, buffer] = renderPixbuf.save_to_bufferv("png", [], []);
                if (success) {
                    const bytes = GLib.Bytes.new(buffer);
                    const icon = Gio.BytesIcon.new(bytes);
                    this.menuImage.content = null;
                    this.menuImage.gicon = icon;
                    this.menuImage.iconSize = width;
                    this.menuImage.width = width;
                    this.menuImage.height = height;
                    artSet = true;
                }
            }
        }
        if (artSet === false) {
            this.menuImage.content = null;
            this.menuImage.gicon = Gio.ThemedIcon.new("audio-x-generic-symbolic");
            this.menuImage.width = width;
            this.menuImage.height = width;
            this.menuImage.iconSize = width;
        }
        if (this.menuImage.get_parent() == null) {
            this.menuBox.insert_child_above(this.menuImage, this.menuPlayers);
            debugLog("Added menu image");
        }
    }

    /**
     * Returns a copy of the pixbuf with the four corners cut to a rounded
     * rectangle by zeroing the alpha channel of pixels outside the corner arcs.
     *
     * @private
     * @param {GdkPixbuf.Pixbuf} pixbuf
     * @param {number} radius
     * @returns {GdkPixbuf.Pixbuf}
     */
    roundPixbufCorners(pixbuf, radius) {
        let src = pixbuf;
        if (!src.get_has_alpha()) {
            src = src.add_alpha(false, 0, 0, 0);
        }
        const w = src.get_width();
        const h = src.get_height();
        const r = Math.min(Math.floor(radius), Math.floor(Math.min(w, h) / 2));
        if (r <= 0) {
            return src;
        }
        const rowstride = src.get_rowstride();
        const channels = src.get_n_channels();
        const pixels = new Uint8Array(src.get_pixels());
        // 4x4 supersample offsets (0.125, 0.375, 0.625, 0.875) for anti-aliasing
        // the corner arcs. Each pixel's coverage is the fraction of its 16
        // subsamples that fall inside the arc; that scales the alpha channel.
        const samples = [0.125, 0.375, 0.625, 0.875];
        const subN = samples.length * samples.length;
        const r2 = r * r;
        for (let y = 0; y < h; y++) {
            let cy;
            if (y < r) {
                cy = r;
            } else if (y >= h - r) {
                cy = h - r;
            } else {
                continue;
            }
            for (let x = 0; x < w; x++) {
                let cx;
                if (x < r) {
                    cx = r;
                } else if (x >= w - r) {
                    cx = w - r;
                } else {
                    continue;
                }
                let inside = 0;
                for (let sy = 0; sy < samples.length; sy++) {
                    const dy = y + samples[sy] - cy;
                    const dy2 = dy * dy;
                    for (let sx = 0; sx < samples.length; sx++) {
                        const dx = x + samples[sx] - cx;
                        if (dx * dx + dy2 <= r2) {
                            inside++;
                        }
                    }
                }
                if (inside === subN) {
                    continue;
                }
                const offset = y * rowstride + x * channels + 3;
                pixels[offset] = Math.round((pixels[offset] * inside) / subN);
            }
        }
        return GdkPixbuf.Pixbuf.new_from_bytes(
            GLib.Bytes.new(pixels),
            src.get_colorspace(),
            src.get_has_alpha(),
            src.get_bits_per_sample(),
            w,
            h,
            rowstride,
        );
    }

    /**
     * @private
     * @returns {void}
     */
    addMenuLabels() {
        if (this.menuLabels == null) {
            this.menuLabels = new St.BoxLayout({
                vertical: true,
                styleClass: "popup-menu-labels",
            });
        }
        for (const label of [this.menuLabelTitle, this.menuLabelSubtitle, this.menuLabelAlbum]) {
            if (label?.get_parent() === this.menuLabels) {
                this.menuLabels.remove_child(label);
            }
            label?.destroy();
        }
        this.menuLabelTitle = null;
        this.menuLabelSubtitle = null;
        this.menuLabelAlbum = null;

        const width = this.getMenuItemWidth();
        const labels = [];
        if (this.extension.showPopupTitle) {
            this.menuLabelTitle = new ScrollingLabel({
                text: this.playerProxy.metadata["xesam:title"],
                isScrolling: this.extension.scrollLabels,
                initPaused: this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING,
                width,
                scrollSpeed: this.extension.scrollSpeed,
            });
            this.menuLabelTitle.label.add_style_class_name("popup-menu-label-title");
            labels.push(this.menuLabelTitle);
        }
        if (this.extension.showPopupArtist) {
            const artistText = this.playerProxy.metadata["xesam:artist"]?.join(", ") || _("Unknown artist");
            this.menuLabelSubtitle = new ScrollingLabel({
                text: artistText,
                isScrolling: this.extension.scrollLabels,
                initPaused: this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING,
                direction: Clutter.TimelineDirection.BACKWARD,
                width,
                scrollSpeed: this.extension.scrollSpeed,
            });
            this.menuLabelSubtitle.label.add_style_class_name("popup-menu-label-subtitle");
            labels.push(this.menuLabelSubtitle);
        }
        if (this.extension.showPopupAlbum) {
            const albumText = this.playerProxy.metadata["xesam:album"] || _("Unknown album");
            this.menuLabelAlbum = new ScrollingLabel({
                text: albumText,
                isScrolling: this.extension.scrollLabels,
                initPaused: this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING,
                width,
                scrollSpeed: this.extension.scrollSpeed,
            });
            this.menuLabelAlbum.label.add_style_class_name("popup-menu-label-album");
            labels.push(this.menuLabelAlbum);
        }
        for (const label of labels) {
            label.box.xAlign = Clutter.ActorAlign.CENTER;
            this.menuLabels.add_child(label);
        }
        if (labels.length === 0) {
            if (this.menuLabels.get_parent() === this.menuBox) {
                this.menuBox.remove_child(this.menuLabels);
            }
            return;
        }
        if (this.menuLabels.get_parent() == null) {
            if (this.menuSlider?.get_parent() === this.menuBox) {
                this.menuBox.insert_child_below(this.menuLabels, this.menuSlider);
            } else if (this.menuControls?.get_parent() === this.menuBox) {
                this.menuBox.insert_child_below(this.menuLabels, this.menuControls);
            } else {
                this.menuBox.add_child(this.menuLabels);
            }
            debugLog("Added menu labels");
        }
    }

    /**
     * @private
     * @returns {Promise<void>}
     */
    async addMenuSlider() {
        const position = await this.playerProxy.position.catch(errorLog);
        const length = this.playerProxy.metadata["mpris:length"];
        const rate = this.playerProxy.rate;
        if (this.menuSlider == null) {
            this.menuSlider = new MenuSlider();
            this.menuSlider.connect("seeked", (_, position) => {
                this.playerProxy.setPosition(this.playerProxy.metadata["mpris:trackid"], position);
            });
        }
        if (position != null && length != null && length > 0) {
            this.menuSlider.setDisabled(false);
            this.menuSlider.updateSlider(position, length, rate);
            if (this.playerProxy.playbackStatus === PlaybackStatus.PLAYING) {
                this.menuSlider.resumeTransition();
            } else {
                this.menuSlider.pauseTransition();
            }
        } else {
            this.menuSlider.setDisabled(true);
        }
        if (this.menuSlider.get_parent() == null) {
            if (this.menuLabels?.get_parent() === this.menuBox) {
                this.menuBox.insert_child_above(this.menuSlider, this.menuLabels);
            } else if (this.menuControls?.get_parent() === this.menuBox) {
                this.menuBox.insert_child_below(this.menuSlider, this.menuControls);
            } else {
                this.menuBox.add_child(this.menuSlider);
            }
            debugLog("Added menu slider");
        }
    }

    /**
     * @private
     * @param {WidgetFlags} flags
     * @returns {void}
     */
    addMenuControls(flags) {
        if (this.menuControls == null) {
            this.menuControls = new St.BoxLayout({
                vertical: true,
                styleClass: "popup-menu-controls",
                xAlign: Clutter.ActorAlign.CENTER,
            });
        }
        if (this.menuMainControls == null) {
            this.menuMainControls = new St.BoxLayout({
                styleClass: "popup-menu-main-controls",
                xAlign: Clutter.ActorAlign.CENTER,
            });
        }
        if (this.menuSecondaryControls == null) {
            this.menuSecondaryControls = new St.BoxLayout({
                styleClass: "popup-menu-secondary-controls",
                xAlign: Clutter.ActorAlign.CENTER,
            });
        }
        if (this.menuMainControls.get_parent() == null) {
            this.menuControls.add_child(this.menuMainControls);
        }
        if (this.menuSecondaryControls.get_parent() == null) {
            this.menuControls.add_child(this.menuSecondaryControls);
        }
        if (flags & WidgetFlags.MENU_CONTROLS_LOOP) {
            this.addMenuControlIcon(
                this.playerProxy.loopStatus === LoopStatus.NONE
                    ? ControlIconOptions.LOOP_NONE
                    : this.playerProxy.loopStatus === LoopStatus.TRACK
                      ? ControlIconOptions.LOOP_TRACK
                      : ControlIconOptions.LOOP_PLAYLIST,
                this.playerProxy.loopStatus != null,
                this.playerProxy.toggleLoop.bind(this.playerProxy),
            );
        }
        if (flags & WidgetFlags.MENU_CONTROLS_PREV) {
            this.addMenuControlIcon(
                ControlIconOptions.PREVIOUS,
                this.playerProxy.canGoPrevious && this.playerProxy.canControl,
                this.playerProxy.previous.bind(this.playerProxy),
            );
        }
        if (flags & WidgetFlags.MENU_CONTROLS_PLAYPAUSE) {
            if (this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING) {
                this.addMenuControlIcon(
                    ControlIconOptions.PLAY,
                    this.playerProxy.canPlay && this.playerProxy.canControl,
                    this.playerProxy.play.bind(this.playerProxy),
                );
            } else {
                if (this.playerProxy.canControl && !this.playerProxy.canPause) {
                    this.addMenuControlIcon(
                        ControlIconOptions.STOP,
                        this.playerProxy.canControl,
                        this.playerProxy.stop.bind(this.playerProxy),
                    );
                } else {
                    this.addMenuControlIcon(
                        ControlIconOptions.PAUSE,
                        this.playerProxy.canPause && this.playerProxy.canControl,
                        this.playerProxy.pause.bind(this.playerProxy),
                    );
                }
            }
        }
        if (flags & WidgetFlags.MENU_CONTROLS_NEXT) {
            this.addMenuControlIcon(
                ControlIconOptions.NEXT,
                this.playerProxy.canGoNext && this.playerProxy.canControl,
                this.playerProxy.next.bind(this.playerProxy),
            );
        }
        if (flags & WidgetFlags.MENU_CONTROLS_SHUFFLE) {
            this.addMenuControlIcon(
                this.playerProxy.shuffle ? ControlIconOptions.SHUFFLE_OFF : ControlIconOptions.SHUFFLE_ON,
                this.playerProxy.shuffle != null,
                this.playerProxy.toggleShuffle.bind(this.playerProxy),
            );
        }
        if (this.menuControls.get_parent() == null) {
            this.menuBox.add_child(this.menuControls);
            debugLog("Added menu controls");
        }
    }

    /**
     * @private
     * @param {MenuControlIconOptions} options
     * @param {boolean} reactive
     * @param {() => void} onClick
     * @returns {void}
     */
    addMenuControlIcon(options, reactive, onClick) {
        const isPrimary = options.name === ControlIconOptions.PLAY.name;
        const isSecondary =
            options.name === ControlIconOptions.LOOP_NONE.name || options.name === ControlIconOptions.SHUFFLE_ON.name;
        const isActive =
            options === ControlIconOptions.LOOP_TRACK ||
            options === ControlIconOptions.LOOP_PLAYLIST ||
            options === ControlIconOptions.SHUFFLE_OFF;
        const targetBox = isSecondary ? this.menuSecondaryControls : this.menuMainControls;
        const styleClasses = [
            "button",
            "popup-menu-control-button",
            isPrimary ? "popup-menu-control-button-primary" : "popup-menu-control-button-circular",
            isSecondary ? "popup-menu-control-button-state" : "",
        ]
            .filter(Boolean)
            .join(" ");
        const button = new St.Button({
            name: options.name,
            styleClass: styleClasses,
            trackHover: reactive,
            opacity: reactive ? 255 : 160,
            reactive,
            canFocus: reactive,
            toggleMode: isPrimary || isSecondary,
            checked: isPrimary ? reactive : isActive,
            xAlign: Clutter.ActorAlign.CENTER,
            yAlign: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            iconName: options.iconName,
            styleClass: "popup-menu-icon popup-menu-control-icon",
        });
        button.set_child(icon);
        button.connect("clicked", () => {
            onClick();
        });

        for (const controlsBox of [this.menuMainControls, this.menuSecondaryControls]) {
            const oldIcon = find_child_by_name(controlsBox, options.name);
            if (oldIcon?.get_parent() === controlsBox) {
                controlsBox.remove_child(oldIcon);
                oldIcon.destroy();
            }
        }
        const targetIndex = Math.min(getMenuControlIndex(options), targetBox.get_children().length);
        targetBox.insert_child_at_index(button, targetIndex);
    }

    /**
     * @private
     * @param {number} index
     * @returns {void}
     */
    addButtonIcon(index) {
        const app = getAppByIdAndEntry(this.playerProxy.identity, this.playerProxy.desktopEntry);
        const appIcon = app?.get_icon() ?? Gio.Icon.new_for_string("audio-x-generic-symbolic");
        const coloredClass = this.extension.coloredPlayerIcon ? "colored-icon" : "symbolic-icon";
        const icon = new St.Icon({
            gicon: appIcon,
            styleClass: `system-status-icon no-margin ${coloredClass}`,
        });
        if (this.buttonIcon?.get_parent() === this.buttonBox) {
            this.buttonBox.replace_child(this.buttonIcon, icon);
        } else {
            this.buttonBox.insert_child_at_index(icon, index);
            debugLog("Added icon");
        }
        this.buttonIcon = icon;
    }

    /**
     * @private
     * @param {number} index
     * @returns {void}
     */
    addButtonLabel(index) {
        const label = new ScrollingLabel({
            text: this.getButtonLabelText(),
            width: this.extension.labelWidth,
            isFixedWidth: this.extension.isFixedLabelWidth,
            isScrolling: this.extension.scrollLabels,
            initPaused: this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING,
            scrollSpeed: this.extension.scrollSpeed,
            scrollPauseTime: this.extension.scrollPauseTime,
        });
        if (this.buttonLabel?.get_parent() === this.buttonBox) {
            this.buttonBox.replace_child(this.buttonLabel, label);
        } else {
            this.buttonBox.insert_child_at_index(label, index);
            debugLog("Added label");
        }
        this.buttonLabel = label;
    }

    /**
     * @private
     * @param {number} index
     * @param {WidgetFlags} flags
     * @returns {void}
     */
    addButtonControls(index, flags) {
        if (this.buttonControls == null) {
            this.buttonControls = new St.BoxLayout({
                name: "controls-box",
                styleClass: "panel-controls-box",
            });
        }
        if (flags & WidgetFlags.PANEL_CONTROLS_SEEK_BACKWARD) {
            if (this.extension.showControlIconsSeekBackward) {
                this.addButtonControlIcon(
                    ControlIconOptions.SEEK_BACKWARD,
                    this.playerProxy.seek.bind(this.playerProxy, -5000000),
                    this.playerProxy.canSeek && this.playerProxy.canControl,
                );
            } else {
                this.removeButtonControlIcon(ControlIconOptions.SEEK_BACKWARD);
            }
        }
        if (flags & WidgetFlags.PANEL_CONTROLS_PREVIOUS) {
            if (this.extension.showControlIconsPrevious) {
                this.addButtonControlIcon(
                    ControlIconOptions.PREVIOUS,
                    this.playerProxy.previous.bind(this.playerProxy),
                    this.playerProxy.canGoPrevious && this.playerProxy.canControl,
                );
            } else {
                this.removeButtonControlIcon(ControlIconOptions.PREVIOUS);
            }
        }
        if (flags & WidgetFlags.PANEL_CONTROLS_PLAYPAUSE) {
            if (this.extension.showControlIconsPlay) {
                if (this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING) {
                    this.addButtonControlIcon(
                        ControlIconOptions.PLAY,
                        this.playerProxy.play.bind(this.playerProxy),
                        this.playerProxy.canPlay && this.playerProxy.canControl,
                    );
                } else {
                    if (this.playerProxy.canControl && !this.playerProxy.canPause) {
                        this.addButtonControlIcon(
                            ControlIconOptions.STOP,
                            this.playerProxy.stop.bind(this.playerProxy),
                            this.playerProxy.canControl,
                        );
                    } else {
                        this.addButtonControlIcon(
                            ControlIconOptions.PAUSE,
                            this.playerProxy.pause.bind(this.playerProxy),
                            this.playerProxy.canPause && this.playerProxy.canControl,
                        );
                    }
                }
            } else {
                this.removeButtonControlIcon(ControlIconOptions.PLAY);
            }
        }
        if (flags & WidgetFlags.PANEL_CONTROLS_NEXT) {
            if (this.extension.showControlIconsNext) {
                this.addButtonControlIcon(
                    ControlIconOptions.NEXT,
                    this.playerProxy.next.bind(this.playerProxy),
                    this.playerProxy.canGoNext && this.playerProxy.canControl,
                );
            } else {
                this.removeButtonControlIcon(ControlIconOptions.NEXT);
            }
        }
        if (flags & WidgetFlags.PANEL_CONTROLS_SEEK_FORWARD) {
            if (this.extension.showControlIconsSeekForward) {
                this.addButtonControlIcon(
                    ControlIconOptions.SEEK_FORWARD,
                    this.playerProxy.seek.bind(this.playerProxy, 5000000),
                    this.playerProxy.canSeek && this.playerProxy.canControl,
                );
            } else {
                this.removeButtonControlIcon(ControlIconOptions.SEEK_FORWARD);
            }
        }
        if (this.buttonControls.get_parent() == null) {
            this.buttonBox.insert_child_at_index(this.buttonControls, index);
            debugLog("Added controls");
        }
    }

    /**
     * @private
     * @param {PanelControlIconOptions} options
     * @param {() => void} onClick
     * @param {boolean} reactive
     * @returns {void}
     */
    addButtonControlIcon(options, onClick, reactive) {
        if (options.panelProps === undefined) {
            debugLog(`Media Controls: panelProps is undefined for ${options.name}`);
            return;
        }

        const icon = new St.Icon({
            name: options.name,
            iconName: options.iconName,
            styleClass: "system-status-icon no-margin",
            opacity: reactive ? 255 : 160,
            reactive,
        });

        if (typeof Clutter.ClickGesture !== "undefined") {
            const clickAction = new Clutter.ClickGesture();
            clickAction.set_n_clicks_required(1);
            if (clickAction.set_recognize_on_press) {
                clickAction.set_recognize_on_press(true);
            }
            clickAction.connect("recognize", () => {
                onClick();
                return Clutter.EVENT_STOP;
            });
            icon.add_action(clickAction);
        } else {
            const clickAction = new Clutter.ClickAction();
            clickAction.connect("clicked", () => {
                onClick();
            });
            icon.add_action(clickAction);
        }

        const oldIcon = find_child_by_name(this.buttonControls, options.name);
        if (oldIcon != null) {
            this.buttonControls.replace_child(oldIcon, icon);
        } else {
            this.buttonControls.insert_child_at_index(icon, options.panelProps.index);
        }
    }

    /**
     * @private
     * @param {ControlIconOptions} options
     * @returns {void}
     */
    removeButtonControlIcon(options) {
        const icon = find_child_by_name(this.buttonControls, options.name);
        if (icon != null) {
            this.buttonControls.remove_child(icon);
            icon.destroy();
        }
    }

    /**
     * @private
     * @returns {string}
     */
    getButtonLabelText() {
        const labelTextElements = [];
        for (const labelElement of this.extension.labelsOrder) {
            if (LabelTypes[labelElement] === LabelTypes.TITLE) {
                labelTextElements.push(this.playerProxy.metadata["xesam:title"]);
            } else if (LabelTypes[labelElement] === LabelTypes.ARTIST) {
                labelTextElements.push(this.playerProxy.metadata["xesam:artist"]?.join(", ") || _("Unknown artist"));
            } else if (LabelTypes[labelElement] === LabelTypes.ALBUM) {
                labelTextElements.push(this.playerProxy.metadata["xesam:album"] || _("Unknown album"));
            } else if (LabelTypes[labelElement] === LabelTypes.DISC_NUMBER) {
                labelTextElements.push(this.playerProxy.metadata["xesam:discNumber"]);
            } else if (LabelTypes[labelElement] === LabelTypes.TRACK_NUMBER) {
                labelTextElements.push(this.playerProxy.metadata["xesam:trackNumber"]);
            } else {
                labelTextElements.push(labelElement);
            }
        }
        return labelTextElements.join(" ").replace(/[\r\n]+/g, " ");
    }

    /**
     * @private
     * @returns {number}
     */
    getMenuItemWidth() {
        return POPUP_CONTENT_WIDTH;
    }

    /**
     * @private
     * @returns {number}
     */
    getCoverArtWidth() {
        return POPUP_COVER_WIDTH;
    }

    /**
     * @private
     * @returns {void}
     */
    syncColorSchemeStyle() {
        if (this.menuBox == null) {
            return;
        }
        const colorScheme = this.interfaceSettings.get_string("color-scheme");
        const preferLight = colorScheme === "prefer-light";
        this.menuBox.remove_style_class_name("media-controls-dark");
        this.menuBox.remove_style_class_name("media-controls-light");
        this.menuBox.add_style_class_name(preferLight ? "media-controls-light" : "media-controls-dark");
    }

    /**
     * @private
     * @returns {void}
     */
    addProxyListeners() {
        this.addProxyListener("Metadata", () => {
            this.updateWidgets(
                WidgetFlags.PANEL_LABEL | WidgetFlags.MENU_IMAGE | WidgetFlags.MENU_LABELS | WidgetFlags.MENU_SLIDER,
            );
        });
        this.addProxyListener("PlaybackStatus", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_PLAYPAUSE | WidgetFlags.MENU_CONTROLS_PLAYPAUSE);
            if (this.playerProxy.playbackStatus !== PlaybackStatus.PLAYING) {
                this.buttonLabel?.pauseScrolling();
                this.menuLabelTitle?.pauseScrolling();
                this.menuLabelSubtitle?.pauseScrolling();
                this.menuLabelAlbum?.pauseScrolling();
                this.menuSlider?.pauseTransition();
            } else {
                this.buttonLabel?.resumeScrolling();
                this.menuLabelTitle?.resumeScrolling();
                this.menuLabelSubtitle?.resumeScrolling();
                this.menuLabelAlbum?.resumeScrolling();
                this.menuSlider?.resumeTransition();
            }
        });
        this.addProxyListener("CanPlay", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_PLAYPAUSE | WidgetFlags.MENU_CONTROLS_PLAYPAUSE);
        });
        this.addProxyListener("CanPause", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_PLAYPAUSE | WidgetFlags.MENU_CONTROLS_PLAYPAUSE);
        });
        this.addProxyListener("CanSeek", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_SEEK_FORWARD | WidgetFlags.PANEL_CONTROLS_SEEK_BACKWARD);
        });
        this.addProxyListener("CanGoNext", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_NEXT | WidgetFlags.MENU_CONTROLS_NEXT);
        });
        this.addProxyListener("CanGoPrevious", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS_PREVIOUS | WidgetFlags.MENU_CONTROLS_PREV);
        });
        this.addProxyListener("CanControl", () => {
            this.updateWidgets(WidgetFlags.PANEL_CONTROLS | WidgetFlags.MENU_CONTROLS);
        });
        this.addProxyListener("Shuffle", () => {
            this.updateWidgets(WidgetFlags.MENU_CONTROLS_SHUFFLE);
        });
        this.addProxyListener("LoopStatus", () => {
            this.updateWidgets(WidgetFlags.MENU_CONTROLS_LOOP);
        });
        this.addProxyListener("IsPinned", () => {
            this.updateWidgets(WidgetFlags.MENU_PLAYERS);
        });
        this.addProxyListener("Rate", () => {
            this.menuSlider?.setRate(this.playerProxy.rate);
        });
        this.playerProxy.onSeeked((position) => {
            this.menuSlider?.setPosition(position);
        });
    }

    /**
     * @private
     * @returns {void}
     */
    removeProxyListeners() {
        for (const [property, id] of this.changeListenerIds.entries()) {
            this.playerProxy.removeListener(property, id);
        }
    }

    /**
     * @private
     * @param {KeysOf<PlayerProxyProperties>} property
     * @param {(...args: unknown[]) => void} callback
     * @returns {void}
     */
    addProxyListener(property, callback) {
        const safeCallback = () => {
            if (this.playerProxy != null) {
                callback();
            }
        };
        const id = this.playerProxy.onChanged(property, safeCallback);
        this.changeListenerIds.set(property, id);
    }

    /**
     * @private
     * @returns {void}
     */
    initActions() {
        if (typeof Clutter.ClickGesture !== "undefined") {
            // GNOME 50 replaced PanelMenu.Button's vfunc_event with a
            // Clutter.ClickGesture, so button-press-event no longer fires
            // reliably for non-primary buttons. Disable the parent's gesture
            // (which only toggles the menu on left click) and install our own
            // per-button gestures so right/middle clicks work again.
            if (this._clickGesture && typeof this._clickGesture.set_enabled === "function") {
                this._clickGesture.set_enabled(false);
            }

            this.addPanelClickGesture(Clutter.BUTTON_PRIMARY, () => this.handleLeftClick());
            this.addPanelClickGesture(Clutter.BUTTON_MIDDLE, () => {
                const action = this.extension.mouseActionMiddle;
                if (action !== MouseActions.NONE) {
                    this.doMouseAction(action);
                }
            });
            this.addPanelClickGesture(Clutter.BUTTON_SECONDARY, () => {
                const action = this.extension.mouseActionRight;
                if (action !== MouseActions.NONE) {
                    this.doMouseAction(action);
                }
            });
        } else {
            this.connect("button-press-event", (_, /** @type {Clutter.Event} */ event) => {
                const button = event.get_button();

                if (button === Clutter.BUTTON_PRIMARY) {
                    this.handleLeftClick();
                    return Clutter.EVENT_STOP;
                }

                let action;
                if (button === Clutter.BUTTON_MIDDLE) {
                    action = this.extension.mouseActionMiddle;
                } else if (button === Clutter.BUTTON_SECONDARY) {
                    action = this.extension.mouseActionRight;
                }

                if (action === MouseActions.NONE) {
                    return Clutter.EVENT_PROPAGATE;
                }

                this.doMouseAction(action);
                return Clutter.EVENT_STOP;
            });

            this.connect("touch-event", (_, /** @type {Clutter.Event} */ event) => {
                const eventType = event.type();
                if (eventType === Clutter.EventType.TOUCH_BEGIN) {
                    this.handleLeftClick();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            });
        }

        this.connect("scroll-event", (_, /** @type {Clutter.Event} */ event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP) {
                this.doMouseAction(this.extension.mouseActionScrollUp);
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                this.doMouseAction(this.extension.mouseActionScrollDown);
            }
            return Clutter.EVENT_STOP;
        });
    }

    /**
     * @private
     * @param {number} button
     * @param {() => void} callback
     * @returns {void}
     */
    addPanelClickGesture(button, callback) {
        const gesture = new Clutter.ClickGesture();
        if (typeof gesture.set_required_button === "function") {
            gesture.set_required_button(button);
        }
        if (typeof gesture.set_recognize_on_press === "function") {
            gesture.set_recognize_on_press(true);
        }
        gesture.connect("recognize", () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        this.add_action(gesture);
    }

    handleLeftClick() {
        // Left click uses double-tap detection, but only if there is a
        // double click action set by the user
        if (this.extension.mouseActionDouble === MouseActions.NONE) {
            this.doMouseAction(this.extension.mouseActionLeft);
            return;
        }

        if (this.doubleTapSourceId === null) {
            this.doubleTapSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.doubleTapSourceId = null;
                this.doMouseAction(this.extension.mouseActionLeft);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            GLib.source_remove(this.doubleTapSourceId);
            this.doubleTapSourceId = null;
            this.doMouseAction(this.extension.mouseActionDouble);
        }
    }

    /**
     * @private
     * @param {MouseActions} action
     * @returns {void}
     */
    doMouseAction(action) {
        switch (action) {
            case MouseActions.PLAY_PAUSE: {
                this.playerProxy.playPause();
                break;
            }
            case MouseActions.PLAY: {
                this.playerProxy.play();
                break;
            }
            case MouseActions.PAUSE: {
                this.playerProxy.pause();
                break;
            }
            case MouseActions.NEXT_TRACK: {
                this.playerProxy.next();
                break;
            }
            case MouseActions.PREVIOUS_TRACK: {
                this.playerProxy.previous();
                break;
            }
            case MouseActions.VOLUME_UP: {
                this.playerProxy.volume = Math.min(this.playerProxy.volume + 0.05, 1);
                break;
            }
            case MouseActions.VOLUME_DOWN: {
                this.playerProxy.volume = Math.max(this.playerProxy.volume - 0.05, 0);
                break;
            }
            case MouseActions.TOGGLE_LOOP: {
                this.playerProxy.toggleLoop();
                break;
            }
            case MouseActions.TOGGLE_SHUFFLE: {
                this.playerProxy.toggleShuffle();
                break;
            }
            case MouseActions.SHOW_POPUP_MENU: {
                this.menu.toggle();
                break;
            }
            case MouseActions.RAISE_PLAYER: {
                this.playerProxy.raise();
                break;
            }
            case MouseActions.QUIT_PLAYER: {
                this.playerProxy.quit();
                break;
            }
            case MouseActions.OPEN_PREFERENCES: {
                this.extension.openPreferences();
                break;
            }
            default:
                break;
        }
    }

    /**
     * @private
     * @returns {void}
     */
    onDestroy() {
        if (this.interfaceSettingsChangedId != null) {
            this.interfaceSettings.disconnect(this.interfaceSettingsChangedId);
            this.interfaceSettingsChangedId = null;
        }
        this.interfaceSettings = null;
        this.removeProxyListeners();
        this.playerProxy = null;
        // Null out references to child widgets before parent destroys them
        this.menuSlider = null;
        this.menuPlayers = null;
        this.menuImage = null;
        this.menuLabels = null;
        this.menuControls = null;
        this.menuMainControls = null;
        this.menuSecondaryControls = null;
        this.buttonIcon?.destroy();
        this.buttonLabel?.destroy();
        this.buttonControls?.destroy();
        this.buttonBox?.destroy();
        this.buttonIcon = null;
        this.buttonLabel = null;
        this.buttonControls = null;
        this.buttonBox = null;
        this.menuBox = null;
        this.menuPlayersTextBox = null;
        this.menuPlayersTextBoxIcon = null;
        this.menuPlayersTextBoxLabel = null;
        this.menuPlayersTextBoxPin = null;
        if (this.menuPlayerIcons != null) {
            this.menuPlayerIcons.get_children().forEach((child) => child.destroy());
        }
        this.menuPlayerIcons = null;
        this.menuPlayersExpanded = false;
        this.menuLabelTitle = null;
        this.menuLabelSubtitle = null;
        this.menuLabelAlbum = null;
        if (this.doubleTapSourceId != null) {
            GLib.source_remove(this.doubleTapSourceId);
            this.doubleTapSourceId = null;
        }
    }
}

const GPanelButton = GObject.registerClass(
    {
        GTypeName: "PanelButton",
        Properties: {},
    },
    PanelButton,
);

export default GPanelButton;
