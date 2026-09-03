# Halden TP-60 label printer

The TP-60 is the wide-format machine in the TP range. It shares its ribbon and
its driver with the TP-40, which is the source of most support calls about it:
the two behave differently in three places, and all three are below.

## Paper the tray will take

The tray takes label stock between 80 and 300 grams per square metre. The
minimum is higher than the TP-40's because the wider drive roller needs more
stiffness to pull straight; light stock skews and the print walks across the
label.

Continuous stock is supported up to 220 mm wide, twice what the TP-40 takes.

## Margins

The smallest margin the TP-60 will print is 6 mm on the left and right edges and
4 mm at the top and bottom. This is the second place the two machines differ,
and a layout moved from a TP-40 will clip at the sides without saying so.

## Replacing the print head

The head is rated for 80 km of ribbon. It is not the same part as the TP-40
head and will not fit: the mounting is 20 mm wider and the connector has an
extra pin.

## Duplex and the cutter

The TP-60 is the only machine in the range with a cutter. It is fitted at the
factory and cannot be added later; a machine without one reports `NO_CUTTER`
when a job asks for a cut and prints the job uncut rather than refusing it.

## Network settings

Identical to the TP-40, including `NETWORK_MODE`. This is the one place the two
machines are the same and everybody assumes they are not.
