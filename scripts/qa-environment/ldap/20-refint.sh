#!/bin/bash
# Runs once per volume, so also on the first start of a volume older than this
# script: every step is skipped when already done, since a failing script stops
# slapd.
set -o errexit

. /opt/bitnami/scripts/libopenldap.sh
eval "$(ldap_env)"

search() {
  ldapsearch -LLL -Q -o ldif-wrap=no -Y EXTERNAL -H ldapi:/// "$@"
}

# slapd is stopped between initialization and these scripts.
ldap_start_bg

# The image always creates cn=module{0}, to load pw-sha2.
if ! search -b 'cn=module{0},cn=config' -s base olcModuleLoad | grep -q 'refint'; then
  ldapmodify -Y EXTERNAL -H ldapi:/// <<'EOF'
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: /opt/bitnami/openldap/lib/openldap/refint.so
EOF
fi

# An erased user leaves every group; a group losing its last member keeps the
# placeholder the ldap-rest group manager also uses, as groupOfNames needs one.
if ! search -b 'olcDatabase={2}mdb,cn=config' '(olcOverlay=refint)' dn | grep -q '^dn:'; then
  ldapadd -Y EXTERNAL -H ldapi:/// <<'EOF'
dn: olcOverlay=refint,olcDatabase={2}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcRefintConfig
olcOverlay: refint
olcRefintAttribute: member
olcRefintNothing: cn=placeholder
EOF
fi

# An erased user or deleted group also leaves every space, in a second overlay:
# olcRefintNothing applies to all the attributes of its overlay, and a space
# role left empty must go away rather than hold the placeholder. A volume made
# before the space schema lacks these attributes, which refint refuses.
if ! search -b cn=schema,cn=config olcAttributeTypes | grep -q "NAME 'twakeSpaceAdmin'"; then
  echo "The space attributes are not in the schema, skipping their refint"
elif ! search -b 'olcDatabase={2}mdb,cn=config' '(&(olcOverlay=refint)(olcRefintAttribute=twakeSpaceAdmin))' dn | grep -q '^dn:'; then
  ldapadd -Y EXTERNAL -H ldapi:/// <<'EOF'
dn: olcOverlay=refint,olcDatabase={2}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcRefintConfig
olcOverlay: refint
olcRefintAttribute: twakeSpaceAdmin
olcRefintAttribute: twakeSpaceEditor
olcRefintAttribute: twakeSpaceViewer
EOF
fi

ldap_stop
