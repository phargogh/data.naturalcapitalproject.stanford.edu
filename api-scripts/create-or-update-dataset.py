"""A script to take an MCF and upload it to CKAN.

If the dataset already exists, then its attributes are updated.

Dependencies:
    $ mamba install ckanapi pyyaml
"""
import collections
import datetime
import hashlib
import json
import logging
import os
import pprint
import sys

import ckanapi.errors
import requests
import yaml
from ckanapi import RemoteCKAN

logging.basicConfig(level=logging.DEBUG)
LOGGER = logging.getLogger(os.path.basename(__file__))

URL = "https://data.naturalcapitalproject.stanford.edu"

MODIFIED_APIKEY = os.environ['CKAN_APIKEY']


def _hash_file_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            data = f.read(2**16)  # read in 64k at a time
            if not data:
                break
            sha256.update(data)
    return sha256.hexdigest()


def _get_created_date(filepath):
    return datetime.datetime.utcfromtimestamp(
        os.path.getctime(filepath))


def _find_license(license_string, license_url, known_licenses):

    # CKAN license IDs use:
    #   - dashes instead of spaces
    #   - all caps
    sanitized_license_string = license_string.strip().replace(
        ' ', '-').upper()

    # CKAN license URLs are expected to have a trailing backslash
    if not license_url.endswith('/'):
        license_url = f'{license_url}/'

    string_to_licenseid = {}
    url_to_licenseid = {}
    for license_data in known_licenses:
        license_id = license_data['id']
        url_to_licenseid[license_data['url']] = license_id
        string_to_licenseid[license_data['title']] = license_id
        if 'legacy_ids' in license_data:
            for legacy_id in license_data['legacy_ids']:
                string_to_licenseid[legacy_id] = license_id

    # TODO do a difflib comparison for similar strings if no match found

    if license_url:
        return url_to_licenseid[license_url]
    else:
        return string_to_licenseid[sanitized_license_string]


def _get_from_mcf(mcf, dot_keys):
    """Retrieve an attribute from an MCF.

    If the attribute is not defined, an empty string is returned.

    Args:
        mcf (dict): The full MCF dictionary
        dot_keys (str): A dot-separated sequence of keys to sequentially index
            into the MCF.  For example: ``identification.abstract``

    Returns:
        value: The value of the attribute at the specified depth, or the empty
        string if the attribute indicated by ``dot_keys`` is not found.
    """
    print("looking for", dot_keys)
    current_mcf_value = mcf
    mcf_keys = collections.deque(dot_keys.split('.'))
    while True:
        key = mcf_keys.popleft()
        try:
            current_mcf_value = current_mcf_value[key]
            if not mcf_keys:  # we're at the root node
                return current_mcf_value
        except KeyError:
            break
    LOGGER.warning(f"MCF does not contain {dot_keys}: {key} not found")
    return ''


def _create_tags_dicts(mcf):
    tags_list = _get_from_mcf(mcf, 'identification.keywords')
    return [{'name': name} for name in tags_list]


def _get_wgs84_bbox(mcf):
    extent = _get_from_mcf(mcf, 'identification.extents.spatial')[0]
    assert int(extent['crs']) == 4326, 'CRS must be EPSG:4326'

    minx, miny, maxx, maxy = extent['bbox']

    return [[[minx, maxy], [minx, miny], [maxx, miny], [maxx, maxy],
             [minx, maxy]]]


def main():
    with open(sys.argv[1]) as yaml_file:
        LOGGER.debug(f"Loading MCF from {sys.argv[1]}")
        mcf = yaml.load(yaml_file.read(), Loader=yaml.Loader)

    session = requests.Session()
    session.headers.update({'Authorization': MODIFIED_APIKEY})

    with RemoteCKAN(URL, apikey=MODIFIED_APIKEY) as catalog:
        print('list org natcap', catalog.action.organization_list(id='natcap'))

        # TODO: can we force CKAN to refresh the license list?
        # It's still using the old 15-license list, not the full list.
        licenses = catalog.action.license_list()
        print(f"{len(licenses)} licenses found")

        if _get_from_mcf(mcf, 'identification.license'):
            _find_license(
                _get_from_mcf(mcf, 'identification.license.name'),
                _get_from_mcf(mcf, 'identification.license.url'),
                licenses)

        # does the package already exist?

        title = _get_from_mcf(mcf, 'identification.title')
        name = _get_from_mcf(mcf, 'metadata.identifier')
        try:
            # check if the package exists
            try:
                LOGGER.info(
                    f"Checking to see if package exists with name={name}")
                pkg_dict = catalog.action.package_show(name_or_id=name)
                LOGGER.info(f"Package already exists name={name}")
            except ckanapi.errors.NotFound:
                LOGGER.info(
                    f"Package not found; creating package with name={name}")

                # keys into the first contact info listing
                possible_author_keys = [
                    'individualname',
                    'organization',
                ]
                first_contact_info = list(mcf['contact'].values())[0]
                for author_key in possible_author_keys:
                    if first_contact_info[author_key]:
                        break  # just keep author_key

                pkg_dict = catalog.action.package_create(
                    name=name,
                    title=title,
                    private=False,
                    author=first_contact_info[author_key],
                    author_email=first_contact_info['email'],
                    owner_org='natcap',
                    notes=_get_from_mcf(mcf, 'identification.abstract'),
                    url=_get_from_mcf(mcf, 'identification.url'),
                    version=_get_from_mcf(mcf, 'identification.edition'),
                    groups=[],

                    # Just use existing tags as CKAN "free" tags
                    # TODO: support defined vocabularies
                    tags=_create_tags_dicts(mcf),

                    # We can define the bbox as a polygon using
                    # ckanext-spatial's spatial extra
                    extras=[{
                        'key': 'spatial',
                        'value': json.dumps({
                            'type': 'Polygon',
                            'coordinates': _get_wgs84_bbox(mcf),
                        }),
                    }],
                )
            pprint.pprint(pkg_dict)

            # Resources:
            #   * The file we're referring to (at a different URL)
            #   * The ISO XML
            #   * The MCF file

            attached_resources = pkg_dict['resources']

            # if there are no resources, attach the MCF as a resource.
            if not attached_resources:
                LOGGER.info(f"Creating resource for {sys.argv[1]}")
                catalog.action.resource_create(
                    # URL parameter is not required by CKAN >=2.6
                    package_id=pkg_dict['id'],
                    description="Metadata Control File for this dataset",
                    format="YML",
                    hash=f"sha256:{_hash_file_sha256(sys.argv[1])}",
                    name=os.path.basename(sys.argv[1]),
                    #resource_type=  # not clear what this should be
                    mimetype='application/yaml',
                    #mimetype_inner  # what is this??
                    size=os.path.getsize(sys.argv[1]),
                    # Assuming "created" is when the metadata was created on ckan,
                    # but we should decide that officially.
                    #TODO: what should "created" date represent?
                    created=datetime.datetime.now().isoformat(),
                    last_modified=datetime.datetime.now().isoformat(),
                    cache_last_updated=datetime.datetime.now().isoformat(),
                    upload=open(sys.argv[1], 'rb')
                )

        except AttributeError:
            print(dir(catalog.action))


if __name__ == '__main__':
    main()
