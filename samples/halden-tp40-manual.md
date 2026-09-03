# Halden TP-40 label printer

The TP-40 is a desktop thermal transfer printer for shelf and carton labels. It
is the smallest machine in the TP range and shares its ribbon with the TP-60.

## Loading a ribbon

Open the top cover and lift the print head by the green lever. The ribbon feeds
from the rear spindle, under the head, to the take-up spindle at the front.
Wind two turns onto the take-up spindle by hand before closing the head, or the
first ten labels will print blank.

## Paper the tray will take

The tray takes label stock between 60 and 200 grams per square metre. Anything
lighter creases against the head; anything heavier will not turn the drive
roller and the printer reports a feed fault after three attempts.

Continuous stock is supported up to 110 mm wide. Die-cut labels must have a gap
of at least 2 mm between them for the sensor to see.

## Margins

The smallest margin the TP-40 will print is 4 mm on every edge. A layout with a
smaller margin is not refused: the printer accepts it and clips it, which is
worse, because nothing on screen says the label came out short.

Set the margin in the driver rather than in the label editor. The driver value
wins, and a layout that disagrees with it is silently adjusted.

## Replacing the print head

The head is rated for 50 km of ribbon, which is about 40,000 labels at the
default size. Replace it when print quality falls off at one edge rather than
across the whole label: an even fade is a ribbon problem, an uneven one is the
head.

Turn the machine off at the switch and wait two minutes before touching the
head. It runs at 300 °C in normal use.

## Cleaning

Clean the head with the pad supplied, never with a solvent. One pass every
5,000 labels is enough in an office; in a warehouse, every 1,000.

## Network settings

The TP-40 takes an address by DHCP by default. To set one by hand, hold the
feed button for eight seconds until the status light turns amber, then use the
configuration page at the address printed on the self-test label.

The setting that controls this is `NETWORK_MODE`, which takes `dhcp` or
`static`. Changing it needs a restart of the printer, not just of the driver.
