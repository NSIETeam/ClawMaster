# Office third-party notice

This package includes ONLYOFFICE local editing resources distributed by [sweetwisdom/onlyoffice-web-local](https://github.com/sweetwisdom/onlyoffice-web-local/tree/c4905016372a633cfba59a78f0acb3f029c85883), release-8. Copyright belongs to Ascensio System SIA and the upstream contributors. The runtime and modified converter are distributed under [GNU AGPL version 3](LICENSE), including the upstream additional terms concerning legal notices and logos.

The [provenance record](vendor/onlyoffice-web-local/SOURCE.json) identifies exact upstream bytes. The [converter patch](patches/onlyoffice-x2t.patch) returns converted bytes to the owning file viewer instead of invoking a browser download, accepts the upstream serialized document representation and uses owned byte arrays for browser Blob compatibility. The local adapter sources, build scripts, dependency lock, converter and patch are included under the runtime's `source/` directory. The viewer's ONLYOFFICE link opens these sources and the upstream source link without uploading a document.

Corresponding ClawMaster integration source is distributed in [ClawMaster-Desktop](https://github.com/NSIETeam/ClawMaster-Desktop/tree/main/frontends/office). ONLYOFFICE names, marks and legal notices retain their upstream ownership. This bundle does not change the license of unrelated DSH packages; their existing notices remain in the desktop distribution.

The [browser compatibility transformations](scripts/editor-compatibility.mjs) load a capability adapter in the three editor pages, skip unavailable Chromium memory statistics and correct the presentation theme manifest URL. The adapter and transformation sources are included under `source/adapter/` and `source/scripts/`; upstream legal markup is retained.
